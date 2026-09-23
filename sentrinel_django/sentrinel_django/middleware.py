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
from typing import Any, Callable

from . import context, errors
from .collector import get_collector
from .config import Config
from .settings import from_django_settings
from .masking import mask_body, mask_mapping
from .routes import route_for
from .sampling import should_capture
from .trace import generate_span_id, generate_trace_id, parse_traceparent
from .tracing import request_trace

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


def status_for_exception(exc: BaseException) -> int:
    """The status Django will answer with for an exception a view raised.

    ``Http404`` is a 404 and ``PermissionDenied`` a 403 — Django turns them into
    those responses itself. Recording every raise as a 500 filed each missing
    record under server errors and inflated the one number that says the
    service is broken.
    """
    try:
        from django.core.exceptions import PermissionDenied, SuspiciousOperation
        from django.http import Http404
    except Exception:  # pragma: no cover - Django is present wherever this runs
        return 500
    if isinstance(exc, Http404):
        return 404
    if isinstance(exc, PermissionDenied):
        return 403
    if isinstance(exc, SuspiciousOperation):
        return 400
    try:
        from django.core.exceptions import BadRequest  # Django 3.2+

        if isinstance(exc, BadRequest):
            return 400
    except ImportError:
        pass
    return 500


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

        # A request that arrived with a traceparent continues that trace rather
        # than starting a new one. Without this, a tap in the mobile app and the
        # server work it caused are two unrelated rows, and the one timeline
        # spanning both — the reason the SDKs send the header at all — does not
        # exist.
        incoming = parse_traceparent((getattr(request, "META", {}) or {}).get("HTTP_TRACEPARENT"))
        state = context.begin(
            consumer=self._consumer(request),
            trace_id=incoming.trace_id if incoming else generate_trace_id(),
            span_id=generate_span_id(),
            parent_span_id=incoming.parent_span_id if incoming else None,
        )
        started = time.perf_counter()
        state["started_iso"] = _now_iso()
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
            # The tunnel's own requests are the browser's telemetry in transit,
            # one per flush. Recording them filled the endpoint list with a
            # route nobody wrote and a request row per page per ten seconds.
            if not getattr(request, "_sentrinel_skip", False):
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
                errors.exception_row(
                    exception,
                    method=getattr(request, "method", "GET"),
                    route=route_for(request, _path(request)),
                    status=status_for_exception(exception),
                    state=state,
                )
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

        # A 4xx or 5xx that no exception explained — a validation failure, a
        # permission check, a view that returned HttpResponseNotFound. The Node
        # plugin records these too; without them the Errors page had server
        # errors only and every client error was invisible.
        if (
            cfg.capture_errors
            and status >= 400
            and response is not None
            and not state.get("error_recorded")
        ):
            state["error_recorded"] = True
            self.collector.record_error(
                errors.response_row(
                    method=method,
                    route=route,
                    status=status,
                    state={**state, "consumer": consumer},
                    body=_body_peek(response),
                    content_type=_header(response, "Content-Type"),
                )
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
        trace = request_trace(state, method, route, status, elapsed_ms)
        if trace:
            self.collector.record_trace(trace)


def _path(request: Any) -> str:
    return getattr(request, "path", "") or "/"


def _header(response: Any, name: str) -> str | None:
    try:
        return response.get(name)
    except Exception:
        return None


def _body_peek(response: Any) -> bytes | None:
    """The start of a response body, for its error message. Never a stream."""
    if getattr(response, "streaming", False):
        return None
    try:
        return bytes(response.content[: errors.BODY_PEEK_BYTES])
    except Exception:
        return None


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
