"""Buffering, rolling up, and shipping.

Three properties this has to hold, because a monitoring library that breaks its
host is worse than no monitoring at all:

**It never raises into your request.** Every public entry point swallows its own
errors. A telemetry bug must not become a 500 on a page that worked.

**It never blocks your request.** Recording appends to a list under a lock.
Sending happens on a background thread, so a slow or down Sentrinel costs the
application nothing.

**It never grows without bound.** Buffers are capped. Past the cap the oldest
rows are dropped and counted, because a process that OOMs during an incident
takes the service with it, and the telemetry was supposed to help.

Metrics are rolled up in-process rather than sent per request: one row per
endpoint per flush, whatever the traffic. Sending a metrics row per request
would make the monitoring the load.
"""

from __future__ import annotations

import atexit
import json
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from .config import Config

#: Which process reported a metrics row. Gunicorn runs several, and without
#: this their resource numbers average into something that describes none of
#: them.
INSTANCE_ID = f"{os.uname().nodename if hasattr(os, 'uname') else 'host'}:{os.getpid()}"

_USER_AGENT = "sentrinel-django/0.1.0"


def _percentile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        return 0.0
    idx = min(len(sorted_values) - 1, max(0, int(q * len(sorted_values) + 0.999999) - 1))
    return sorted_values[idx]


class Collector:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._lock = threading.Lock()
        self._requests: list[dict[str, Any]] = []
        self._logs: list[dict[str, Any]] = []
        self._errors: list[dict[str, Any]] = []
        self._traces: list[dict[str, Any]] = []
        self._endpoints: dict[tuple[str, str], dict[str, Any]] = {}
        self._consumers: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._dropped = 0
        self._retry: list[tuple[str, dict[str, Any], int]] = []

        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._started_pid: int | None = None

    # ── Recording ──────────────────────────────────────────────────────────

    def record_request(self, row: dict[str, Any]) -> None:
        with self._lock:
            self._append(self._requests, row)
        self._ensure_started()

    def record_error(self, row: dict[str, Any]) -> None:
        with self._lock:
            self._append(self._errors, row)
        self._ensure_started()

    def record_trace(self, trace: dict[str, Any]) -> None:
        with self._lock:
            self._append(self._traces, trace)
        self._ensure_started()

    def record_logs(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        with self._lock:
            for row in rows:
                self._append(self._logs, row)
        self._ensure_started()

    def record_metrics(
        self,
        method: str,
        route: str,
        status_code: int,
        response_time: float,
        request_size: int,
        response_size: int,
        consumer: str | None,
    ) -> None:
        """Fold one request into the rollup. Called on every request, so cheap."""
        with self._lock:
            key = (method, route)
            m = self._endpoints.get(key)
            if m is None:
                # The cap is on distinct endpoints, which is what a path used as
                # an endpoint key blows up. Dropping new keys past it keeps a
                # templating mistake from becoming unbounded memory.
                if len(self._endpoints) >= 2000:
                    return
                m = self._endpoints[key] = {
                    "method": method,
                    "path": route,
                    "requestCount": 0,
                    "successCount": 0,
                    "errorCount": 0,
                    "responseTimes": [],
                    "statusCodes": {},
                    "totalRequestSize": 0,
                    "totalResponseSize": 0,
                }
            m["requestCount"] += 1
            if status_code >= 400:
                m["errorCount"] += 1
            else:
                m["successCount"] += 1
            # Bounded: percentiles over a flush window do not need every sample,
            # and an endpoint under load would otherwise hold a list per request.
            if len(m["responseTimes"]) < 5000:
                m["responseTimes"].append(response_time)
            code = str(status_code)
            m["statusCodes"][code] = m["statusCodes"].get(code, 0) + 1
            m["totalRequestSize"] += request_size
            m["totalResponseSize"] += response_size

            if consumer:
                ckey = (consumer, method, route)
                c = self._consumers.get(ckey)
                if c is None:
                    if len(self._consumers) >= 5000:
                        return
                    c = self._consumers[ckey] = {
                        "identifier": consumer,
                        "method": method,
                        "path": route,
                        "requestCount": 0,
                        "errorCount": 0,
                        "totalResponseTime": 0.0,
                    }
                c["requestCount"] += 1
                if status_code >= 400:
                    c["errorCount"] += 1
                c["totalResponseTime"] += response_time

    def _append(self, buffer: list[dict[str, Any]], row: dict[str, Any]) -> None:
        """Append under the cap, dropping oldest first.

        Oldest rather than newest: during an incident the rows arriving now are
        the ones being looked for, and the ones from ten minutes ago have
        already been flushed or already lost.
        """
        if len(buffer) >= self.config.max_buffer:
            drop = max(1, len(buffer) // 10)
            del buffer[:drop]
            self._dropped += drop
        buffer.append(row)

    # ── The background thread ──────────────────────────────────────────────

    def _ensure_started(self) -> None:
        """Start the flusher lazily, and again after a fork.

        Gunicorn and uWSGI fork workers after loading the application. A thread
        started in the parent does not exist in the child, so a collector
        started at import time would buffer forever in every worker and flush
        from none of them. Comparing the pid on each record is cheap and makes
        the fork invisible.
        """
        pid = os.getpid()
        if self._thread is not None and self._started_pid == pid and self._thread.is_alive():
            return
        with self._lock:
            if self._thread is not None and self._started_pid == pid and self._thread.is_alive():
                return
            self._stop = threading.Event()
            self._started_pid = pid
            self._thread = threading.Thread(
                target=self._run, name="sentrinel-flush", daemon=True
            )
            self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self.config.flush_interval):
            if os.getpid() != self._started_pid:
                return  # a fork happened; the child starts its own
            try:
                self.flush()
            except Exception as exc:  # never let the thread die on one bad flush
                self._debug("flush failed", exc)

    def shutdown(self) -> None:
        self._stop.set()
        try:
            self.flush()
        except Exception as exc:
            self._debug("final flush failed", exc)

    # ── Sending ────────────────────────────────────────────────────────────

    def flush(self) -> None:
        cfg = self.config
        if not cfg.configured:
            return

        with self._lock:
            requests, self._requests = self._requests, []
            logs, self._logs = self._logs, []
            errors, self._errors = self._errors, []
            traces, self._traces = self._traces, []
            endpoints, self._endpoints = self._endpoints, {}
            consumers, self._consumers = self._consumers, {}
            retry, self._retry = self._retry, []
            dropped, self._dropped = self._dropped, 0

        if dropped:
            self._debug(f"dropped {dropped} buffered rows — raise MAX_BUFFER or lower SAMPLE_RATE")

        for path, payload, attempt in retry:
            self._post(path, payload, attempt)

        if endpoints or consumers:
            self._post("/api/ingest/metrics", self._metrics_payload(endpoints, consumers))
        if requests:
            self._post("/api/ingest/requests", self._envelope(requests=requests))
        if logs:
            self._post("/api/ingest/logs", self._envelope(logs=logs))
        if errors:
            self._post("/api/ingest/errors", self._envelope(errors=errors))

        # One trace per request, and the route takes one at a time.
        for trace in traces:
            self._post("/api/ingest/traces", self._envelope(**trace))

        # Custom metrics ride the same flush. Drained here rather than buffered
        # per call because the registry folds increments in memory — this is one
        # row per series, not one per count().
        from .metrics import registry

        points = registry().drain(_now_iso())
        if points:
            payload = self._envelope(metrics=points)
            if cfg.version:
                payload["version"] = cfg.version
            self._post("/api/ingest/custom-metrics", payload)

    def _envelope(self, **body: Any) -> dict[str, Any]:
        return {"appName": self.config.app_name, "env": self.config.env, **body}

    def _metrics_payload(
        self, endpoints: dict[tuple[str, str], dict[str, Any]], consumers: dict[Any, dict[str, Any]]
    ) -> dict[str, Any]:
        rows = []
        for m in endpoints.values():
            times = sorted(m.pop("responseTimes"))
            n = len(times)
            rows.append(
                {
                    **m,
                    "avgResponseTime": (sum(times) / n) if n else 0.0,
                    "minResponseTime": times[0] if n else 0.0,
                    "maxResponseTime": times[-1] if n else 0.0,
                    "p50ResponseTime": _percentile(times, 0.50),
                    "p95ResponseTime": _percentile(times, 0.95),
                    "p99ResponseTime": _percentile(times, 0.99),
                }
            )
        payload = self._envelope(
            timestamp=_now_iso(),
            endpoints=rows,
            consumers=list(consumers.values()),
        )
        if self.config.version:
            payload["version"] = self.config.version
        usage = _resource_usage()
        if usage:
            payload["resourceUsage"] = usage
        return payload

    def _post(self, path: str, payload: dict[str, Any], attempt: int = 0) -> None:
        cfg = self.config
        url = f"{cfg.server_url}{path}"
        try:
            data = json.dumps(payload, default=str).encode("utf-8")
        except (TypeError, ValueError) as exc:
            self._debug("could not encode payload", exc)
            return  # unencodable now is unencodable on retry

        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", _USER_AGENT)
        if cfg.api_key:
            req.add_header("X-API-Key", cfg.api_key)

        try:
            with urllib.request.urlopen(req, timeout=cfg.timeout) as res:
                res.read()
            return
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            # 4xx is a configuration problem — a wrong key, the wrong kind of
            # key, an app name that does not match. Retrying cannot fix it and
            # would hide it, so say it plainly and drop the batch.
            if 400 <= exc.code < 500:
                self._debug(f"{path} refused ({exc.code}): {body}")
                return
            self._requeue(path, payload, attempt, f"{exc.code}")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            self._requeue(path, payload, attempt, str(exc))

    def _requeue(self, path: str, payload: dict[str, Any], attempt: int, why: str) -> None:
        """Hold a failed batch for the next flush, a few times.

        Sentrinel being briefly unreachable should cost a delay, not the data.
        Retrying forever is the other failure: a queue that only grows is the
        OOM this class exists to avoid.
        """
        if attempt >= 3:
            self._debug(f"{path} failed after {attempt} attempts ({why}); dropping batch")
            return
        with self._lock:
            if len(self._retry) < 50:
                self._retry.append((path, payload, attempt + 1))

    def _debug(self, *parts: Any) -> None:
        if self.config.debug:
            print("[sentrinel]", *parts, flush=True)


def _resource_usage() -> dict[str, Any] | None:
    """CPU and memory for this worker, in the shape the API stores.

    The field names are the Node plugin's — `cpuUsage`, `memoryRss` — because
    the API reads those and one dashboard renders both. Inventing clearer names
    here would have produced rows of nulls that look like the feature is off.

    `resource` is POSIX-only, and neither figure is worth a dependency, so this
    reports what the platform will say and returns None otherwise. The instance
    id matters because gunicorn runs several workers: without it their numbers
    average into something that describes none of them.
    """
    try:
        import resource as _resource
    except ImportError:
        return None

    try:
        usage = _resource.getrusage(_resource.RUSAGE_SELF)
    except Exception:
        return None

    global _last_cpu_seconds, _last_cpu_at
    cpu_seconds = usage.ru_utime + usage.ru_stime
    now = time.monotonic()

    # A percentage over the window since the last flush, not since boot: the
    # lifetime average of a process that was busy an hour ago and idle now
    # describes neither moment.
    percent = 0.0
    if _last_cpu_at is not None:
        elapsed = now - _last_cpu_at
        if elapsed > 0:
            percent = max(0.0, min(100.0 * os.cpu_count() if os.cpu_count() else 100.0,
                                   ((cpu_seconds - _last_cpu_seconds) / elapsed) * 100.0))
    _last_cpu_seconds, _last_cpu_at = cpu_seconds, now

    return {
        "instanceId": INSTANCE_ID,
        "cpuUsage": round(percent, 2),
        "memoryRss": _rss_bytes(usage),
    }


def _rss_bytes(usage: Any) -> int:
    """Resident memory now, falling back to the peak when that is all there is.

    /proc gives the current figure on Linux. Elsewhere `ru_maxrss` is the high
    water mark — not the same number, but the only one available without a
    dependency. Its unit is the portability trap: kilobytes on Linux, bytes on
    macOS, a factor of 1024 in something people read off a chart.
    """
    try:
        with open("/proc/self/statm", "r") as fh:
            pages = int(fh.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE")
    except Exception:
        pass
    import sys

    return int(usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024)


_last_cpu_seconds: float = 0.0
_last_cpu_at: float | None = None


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


_collector: Collector | None = None
_collector_lock = threading.Lock()


def get_collector(config: Config | None = None) -> Collector:
    """The one collector for this process, created on first use.

    A passed config is used only if there is nothing yet. Replacing a live
    collector would throw away whatever it had buffered, and this is called
    from two places that can both run more than once — every middleware
    instance Django builds, and every log record emitted outside a request. A
    second caller must join the existing collector, not evict the first.
    """
    global _collector
    if _collector is None:
        with _collector_lock:
            if _collector is None:
                from .config import from_django_settings

                _collector = Collector(config or from_django_settings())
                atexit.register(_collector.shutdown)
    return _collector


def set_collector(collector: Collector | None) -> None:
    """Install a specific collector. For tests, and for embedding."""
    global _collector
    with _collector_lock:
        _collector = collector


def reset_collector() -> None:
    """Drop the process-wide collector. For tests."""
    global _collector
    with _collector_lock:
        if _collector is not None:
            _collector._stop.set()
        _collector = None
