"""The middleware. One entry in ``MIDDLEWARE`` and the app is instrumented.

Place it first, so the time it measures is the time the user waited — including
whatever the middleware below it spends. Placed last it reports handler time and
quietly under-reports every request that a slow middleware made slow.

Everything here is wrapped: a failure inside the middleware returns the
response the view produced. A monitoring library that can turn a working page
into a 500 has made the service less reliable than it was without it.
"""

from __future__ import annotations

import time
import traceback
from typing import Any, Callable

from . import context
from .collector import get_collector
from .config import Config, from_django_settings
from .masking import mask_body, mask_mapping
from .routes import route_for
from .sampling import should_capture

#: Header names Django exposes as META keys.
_IP_HEADERS = ("HTTP_X_FORWARDED_FOR", "HTTP_X_REAL_IP", "REMOTE_ADDR")


def _client_ip(request: Any) -> str | None:
    """The caller's address, taking the first hop of a forwarding chain.

    ``X-Forwarded-For`` is a list appended to by each proxy, so the client is
    the leftmost entry. Reading the last one reports your own load balancer for
    every request, which looks plausible on a dashboard and is useless.
    """
    meta = getattr(request, "META", {}) or {}
    for header in _IP_HEADERS:
        value = meta.get(header)
        if value:
            first = str(value).split(",")[0].strip()
            if first:
                return first[:45]
    return None


def _headers(request: Any) -> dict[str, str]:
    meta = getattr(request, "META", {}) or {}
    out: dict[str, str] = {}
    for key, value in meta.items():
        if key.startswith("HTTP_"):
            out[key[5:].replace("_", "-").lower()] = str(value)
        elif key in ("CONTENT_TYPE", "CONTENT_LENGTH") and value:
            out[key.replace("_", "-").lower()] = str(value)
    return out


def _default_consumer(request: Any) -> str | None:
    """Who this request belongs to, when the project has not said how.

    ``request.user`` is the near-universal answer in Django, and an
    unauthenticated request genuinely has no consumer — anonymous is a real
    answer, not a missing one.
    """
    user = getattr(request, "user", None)
    if user is None:
        return None
    try:
        if not getattr(user, "is_authenticated", False):
            return None
    except Exception:
        return None
    ident = getattr(user, "pk", None)
    return str(ident) if ident is not None else None


class SentrinelMiddleware:
    """Records every request, and every exception raised out of a view."""

    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response
        self.config: Config = from_django_settings()
        self.collector = get_collector(self.config)

    # ── Django's contract ──────────────────────────────────────────────────

    def __call__(self, request: Any) -> Any:
        if not self.config.configured or self._excluded(request):
            return self.get_response(request)

        state = context.begin(consumer=self._consumer(request))
        started = time.perf_counter()
        request_body = self._read_request_body(request)

        try:
            response = self.get_response(request)
        except Exception:
            # The exception handler below records it; Django turns it into a
            # 500 after we re-raise, and we must not swallow it.
            self._record(request, None, started, state, request_body, status_override=500)
            context.end()
            raise

        try:
            self._record(request, response, started, state, request_body)
        except Exception as exc:  # telemetry must not break the response
            self.collector._debug("record failed", exc)
        finally:
            context.end()
        return response

    def process_exception(self, request: Any, exception: Exception) -> None:
        """Capture the exception with its stack, then let Django handle it."""
        if not self.config.configured or not self.config.capture_errors:
            return None
        try:
            state = context.current() or {}
            # The got_request_exception signal fires for this same exception.
            # Recording both would double every error's occurrence count, which
            # is the number people rank issues by.
            if state.get("error_recorded"):
                return None
            state["error_recorded"] = True
            self.collector.record_error(
                {
                    "method": getattr(request, "method", "GET"),
                    # The route, not the URL. Endpoints are registered by
                    # whatever an error reports here, so sending the raw path
                    # registers a second endpoint for the one the requests
                    # already created — /boom/ beside /boom — and splits an
                    # endpoint's error count away from its traffic.
                    "path": route_for(request, _path(request)),
                    "statusCode": 500,
                    "statusMessage": "Internal Server Error",
                    "errorType": type(exception).__name__,
                    "errorMessage": str(exception)[:2000],
                    "stackTrace": "".join(
                        traceback.format_exception(type(exception), exception, exception.__traceback__)
                    )[:20_000],
                    "consumerIdentifier": state.get("consumer"),
                    "timestamp": _now_iso(),
                    "requestLogId": state.get("request_id"),
                    "traceId": state.get("trace_id"),
                    "attributes": state.get("attributes") or None,
                }
            )
        except Exception as exc:
            self.collector._debug("error capture failed", exc)
        return None

    # ── Internals ──────────────────────────────────────────────────────────

    def _excluded(self, request: Any) -> bool:
        path = _path(request)
        return any(p.search(path) for p in self.config.exclude_paths)

    def _consumer(self, request: Any) -> str | None:
        resolver = self.config.consumer_identifier
        try:
            return resolver(request) if resolver else _default_consumer(request)
        except Exception:
            return None

    def _read_request_body(self, request: Any) -> bytes | None:
        """Read the body before the view consumes it, if it was asked for.

        Django buffers ``request.body`` so reading it here does not starve the
        view — but only up to DATA_UPLOAD_MAX_MEMORY_SIZE, and a streaming
        upload raises instead. Both are the caller's normal behaviour and
        neither is worth an exception from monitoring, so this fails quiet.
        """
        if not self.config.log_request_body:
            return None
        try:
            return request.body
        except Exception:
            return None

    def _record(
        self,
        request: Any,
        response: Any,
        started: float,
        state: dict[str, Any],
        request_body: bytes | None,
        status_override: int | None = None,
    ) -> None:
        cfg = self.config
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        status = status_override if status_override is not None else int(getattr(response, "status_code", 200))
        method = getattr(request, "method", "GET")
        path = _path(request)
        route = route_for(request, path)
        # Identity may only have been decided inside the view.
        consumer = state.get("consumer") or self._consumer(request)

        request_size = int(getattr(request, "META", {}).get("CONTENT_LENGTH") or 0)
        response_size = _response_size(response)

        self.collector.record_metrics(
            method, route, status, elapsed_ms, request_size, response_size, consumer
        )

        if cfg.capture_logs:
            logs = state.get("logs") or []
            if logs:
                for line in logs:
                    line.setdefault("consumerIdentifier", consumer)
                self.collector.record_logs(logs)

        if not cfg.capture_requests:
            return

        decision = should_capture(status, elapsed_ms, cfg.sample_rate, cfg.slow_request_ms)
        if not decision.capture:
            return

        row: dict[str, Any] = {
            "id": state.get("request_id"),
            "method": method,
            "path": path,
            "route": route,
            "statusCode": status,
            "responseTime": round(elapsed_ms, 3),
            "requestSize": request_size,
            "responseSize": response_size,
            "env": cfg.env,
            "consumerIdentifier": consumer,
            "timestamp": _now_iso(),
            "sampleRate": decision.sample_rate,
            "clientIp": _client_ip(request),
            "host": (getattr(request, "META", {}) or {}).get("HTTP_HOST"),
        }

        query = getattr(request, "GET", None)
        if query:
            try:
                row["queryParams"] = mask_mapping(dict(query.items()), cfg.mask_fields)
            except Exception:
                pass

        if cfg.log_request_headers:
            row["requestHeaders"] = mask_mapping(_headers(request), cfg.mask_headers)

        if cfg.log_request_body and request_body:
            row["requestBody"] = mask_body(request_body, cfg.mask_fields, cfg.max_body_bytes)

        if cfg.log_response_body and response is not None and not getattr(response, "streaming", False):
            try:
                row["responseBody"] = mask_body(response.content, cfg.mask_fields, cfg.max_body_bytes)
            except Exception:
                pass

        attributes = state.get("attributes")
        if attributes:
            row["attributes"] = attributes
        if state.get("trace_id"):
            row["traceId"] = state["trace_id"]

        self.collector.record_request(row)


def _path(request: Any) -> str:
    return getattr(request, "path", "") or "/"


def _response_size(response: Any) -> int:
    """Bytes sent back.

    ``response.get()`` rather than ``response.headers``: the mapping was added
    in Django 3.2 and the method works everywhere, which matters because the
    projects most in need of monitoring tend to be the ones on an older Django.
    """
    if response is None:
        return 0
    try:
        value = response.get("Content-Length")
        if value:
            return int(value)
    except Exception:
        pass
    if getattr(response, "streaming", False):
        return 0  # consuming a streaming body to measure it would break it
    try:
        return len(response.content)
    except Exception:
        return 0


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
