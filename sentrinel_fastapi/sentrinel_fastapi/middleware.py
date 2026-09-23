"""The middleware. One ``add_middleware`` call and the app is instrumented.

A pure ASGI middleware rather than Starlette's ``BaseHTTPMiddleware``: that
class runs the rest of the app in a separate task, which breaks streaming
responses and background tasks in ways that are well documented and hard to
see. This wraps ``receive`` and ``send`` instead, so the application's own
messages pass through untouched and it works with any ASGI app — FastAPI,
Starlette, or anything built on them.

Everything here is wrapped: a failure inside it leaves the response exactly as
the app produced it. A monitoring library that can turn a working endpoint into
a 500 has made the service less reliable than it was without it.
"""

from __future__ import annotations

import difflib
import time
from typing import Any, Awaitable, Callable, MutableMapping
from urllib.parse import parse_qsl

from . import context, errors
from .collector import get_collector
from .config import SETTING_KEYS, Config, load
from .masking import mask_body, mask_mapping
from .routes import route_for
from .sampling import should_capture
from .trace import generate_span_id, generate_trace_id, parse_traceparent
from .tracing import request_trace

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def settings_from_options(options: dict[str, Any]) -> dict[str, Any]:
    """Keyword arguments to the settings dict the shared ``load()`` reads.

    ``app_name="orders"`` is ``APP_NAME``. An unknown name is a ``TypeError``
    naming the nearest real one: a misspelt ``api_kye`` that was silently
    ignored would look exactly like a service with no traffic.
    """
    settings: dict[str, Any] = {}
    for name, value in options.items():
        key = name.upper()
        if key not in SETTING_KEYS:
            close = difflib.get_close_matches(key, SETTING_KEYS, n=1)
            hint = f" — did you mean {close[0].lower()!r}?" if close else ""
            raise TypeError(f"SentrinelMiddleware got an unknown option {name!r}{hint}")
        settings[key] = value

    # A header name is the common case for who is calling — "x-tenant", "x-user-id"
    # — and the Node plugin takes one the same way. A dotted path is still a
    # function to import, which is how the shared loader reads a string.
    ident = settings.get("CONSUMER_IDENTIFIER")
    if isinstance(ident, str) and "." not in ident and ident:
        header = ident.lower()
        settings["CONSUMER_IDENTIFIER"] = lambda request: request.headers.get(header)
    return settings


def _headers(scope: Scope) -> dict[str, str]:
    """Request headers, lower-cased, repeated ones joined the way HTTP allows."""
    out: dict[str, str] = {}
    for raw_name, raw_value in scope.get("headers") or ():
        try:
            name = raw_name.decode("latin-1").lower()
            value = raw_value.decode("latin-1")
        except Exception:
            continue
        out[name] = f"{out[name]}, {value}" if name in out else value
    return out


def _client_ip(scope: Scope, headers: dict[str, str]) -> str | None:
    """The caller's address, taking the first hop of a forwarding chain.

    ``X-Forwarded-For`` is a list appended to by each proxy, so the client is
    the leftmost entry. Reading the last one — or the socket, behind a load
    balancer — reports your own infrastructure for every request.
    """
    for header in ("x-forwarded-for", "x-real-ip"):
        value = headers.get(header)
        if value:
            first = value.split(",")[0].strip()
            if first:
                return first[:45]
    client = scope.get("client")
    if client:
        try:
            return str(client[0])[:45]
        except Exception:
            return None
    return None


def _request_object(scope: Scope) -> Any:
    """What a consumer resolver is handed: a Starlette ``Request`` when there is one."""
    try:
        from starlette.requests import Request

        return Request(scope)
    except Exception:
        # A non-Starlette ASGI app. Headers are what a resolver usually wants.
        class _Bare:
            def __init__(self, scope: Scope) -> None:
                self.scope = scope
                self.headers = _headers(scope)

        return _Bare(scope)


def _default_consumer(scope: Scope) -> str | None:
    """Who this request belongs to, when the project has not said how.

    Starlette's ``AuthenticationMiddleware`` puts the user on the scope. An
    unauthenticated request genuinely has no consumer — anonymous is a real
    answer, not a missing one. Read from the scope directly: ``request.user``
    raises when that middleware is not installed.
    """
    user = scope.get("user")
    if user is None:
        return None
    try:
        if not getattr(user, "is_authenticated", False):
            return None
    except Exception:
        return None
    # Each read on its own: Starlette's base user *raises* NotImplementedError
    # for ``identity`` rather than lacking it, so one failed read must not
    # stop the next — on older Starlette, ``SimpleUser`` has only a name.
    for attr in ("identity", "display_name", "username"):
        try:
            ident = getattr(user, attr, None)
        except Exception:
            continue
        if ident:
            return str(ident)
    return None


def _error_type(body: bytes | None, content_type: str | None) -> str | None:
    """FastAPI's own error bodies say what raised them, by shape.

    ``{"detail": [...]}`` is a request that failed validation; ``{"detail": "…"}``
    is an ``HTTPException``. The exception itself never reaches this middleware
    — FastAPI turns it into a response first — so the body is the evidence.
    """
    if not body or (content_type and "json" not in content_type.lower()):
        return None
    try:
        import json

        data = json.loads(body[: errors.BODY_PEEK_BYTES].decode("utf-8", "replace"))
    except ValueError:
        return None
    if isinstance(data, dict) and "detail" in data:
        return "RequestValidationError" if isinstance(data["detail"], list) else "HTTPException"
    return None


class _Probe:
    """What the middleware learns by watching the messages go past."""

    __slots__ = (
        "status",
        "response_headers",
        "request_bytes",
        "request_body",
        "response_bytes",
        "response_body",
        "error_body",
        "finished_at",
        "capture_request",
        "capture_response",
        "max_body",
    )

    def __init__(self, cfg: Config) -> None:
        self.status: int | None = None
        self.response_headers: dict[str, str] = {}
        self.request_bytes = 0
        self.request_body = bytearray()
        self.response_bytes = 0
        self.response_body = bytearray()
        self.error_body = bytearray()
        self.finished_at: float | None = None
        self.capture_request = cfg.log_request_body
        self.capture_response = cfg.log_response_body
        self.max_body = cfg.max_body_bytes


class SentrinelMiddleware:
    """Records every request, and every exception raised through it.

    ```python
    app.add_middleware(
        SentrinelMiddleware,
        server_url="https://api.sentrinel.dev",
        app_name="orders",
        env="prod",
        api_key=os.environ["SENTRINEL_API_KEY"],
    )
    ```

    Every option is also read from the environment — ``SENTRINEL_SERVER_URL``,
    ``SENTRINEL_APP_NAME``, ``SENTRINEL_API_KEY`` … — so a container can be
    configured without touching the code.
    """

    def __init__(self, app: ASGIApp, **options: Any) -> None:
        self.app = app
        self.config: Config = load(settings_from_options(options))
        self.collector = get_collector(self.config)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # WebSockets and lifespan pass straight through: neither is a request
        # with a status, and pretending otherwise would invent both.
        if scope.get("type") != "http" or not self.config.configured:
            await self.app(scope, receive, send)
            return

        path = scope.get("path") or "/"
        if any(p.search(path) for p in self.config.exclude_paths):
            await self.app(scope, receive, send)
            return

        cfg = self.config
        headers = _headers(scope)
        # Captured now: routing rewrites root_path as it goes through mounts,
        # and the difference is the mount prefix of the route that matched.
        entry_root_path = scope.get("root_path") or ""

        # A request that arrived with a traceparent continues that trace rather
        # than starting a new one — a tap in the phone app and the server work
        # it caused are one waterfall, which is why the SDKs send the header.
        incoming = parse_traceparent(headers.get("traceparent"))
        state = context.begin(
            consumer=self._consumer(scope),
            trace_id=incoming.trace_id if incoming else generate_trace_id(),
            span_id=generate_span_id(),
            parent_span_id=incoming.parent_span_id if incoming else None,
        )
        state["scope"] = scope
        state["path"] = path
        state["entry_root_path"] = entry_root_path
        state["started_iso"] = _now_iso()
        started = time.perf_counter()
        probe = _Probe(cfg)

        async def receive_wrapper() -> Message:
            message = await receive()
            try:
                if message.get("type") == "http.request":
                    body = message.get("body") or b""
                    probe.request_bytes += len(body)
                    room = probe.max_body - len(probe.request_body)
                    if probe.capture_request and room > 0:
                        probe.request_body.extend(body[:room])
            except Exception:
                pass
            return message

        async def send_wrapper(message: Message) -> None:
            try:
                kind = message.get("type")
                if kind == "http.response.start":
                    probe.status = int(message.get("status", 200))
                    probe.response_headers = {
                        k.decode("latin-1").lower(): v.decode("latin-1")
                        for k, v in message.get("headers") or ()
                    }
                    if "text/event-stream" in probe.response_headers.get("content-type", ""):
                        probe.capture_response = False  # an endless stream is not a body
                elif kind == "http.response.body":
                    body = message.get("body") or b""
                    probe.response_bytes += len(body)
                    if probe.capture_response:
                        room = probe.max_body - len(probe.response_body)
                        if room > 0:
                            probe.response_body.extend(body[:room])
                    if (probe.status or 0) >= 400:
                        room = errors.BODY_PEEK_BYTES - len(probe.error_body)
                        if room > 0:
                            probe.error_body.extend(body[:room])
                    if not message.get("more_body", False):
                        # The response is complete. Background tasks run after
                        # this inside the same call, and timing them would
                        # blame the endpoint for work the user never waited on.
                        probe.finished_at = time.perf_counter()
            except Exception:
                pass
            await send(message)

        raised: BaseException | None = None
        try:
            await self.app(scope, receive_wrapper, send_wrapper)
        except Exception as exc:
            raised = exc
            raise
        finally:
            try:
                if not scope.get("sentrinel.skip"):
                    self._record(scope, state, probe, started, raised, path, headers, entry_root_path)
            except Exception as err:  # telemetry must not break the response
                self.collector._debug("record failed", err)
            finally:
                context.end()

    # ── Internals ──────────────────────────────────────────────────────────

    def _consumer(self, scope: Scope) -> str | None:
        resolver = self.config.consumer_identifier
        try:
            if resolver:
                value = resolver(_request_object(scope))
                return str(value) if value else None
            return _default_consumer(scope)
        except Exception:
            return None

    def _record(
        self,
        scope: Scope,
        state: dict[str, Any],
        probe: _Probe,
        started: float,
        raised: BaseException | None,
        path: str,
        headers: dict[str, str],
        entry_root_path: str,
    ) -> None:
        cfg = self.config
        if probe.status is None and raised is None:
            # Cancelled before anything was sent — the client went away. There
            # is no status to report, and inventing one would be a guess.
            return
        # An exception with nothing sent yet becomes the server's 500.
        status = probe.status if probe.status is not None else 500
        finished = probe.finished_at if probe.finished_at is not None else time.perf_counter()
        elapsed_ms = (finished - started) * 1000.0
        method = scope.get("method", "GET")
        route = route_for(scope, path, entry_root_path)
        # Identity may only have been decided inside the endpoint.
        consumer = state.get("consumer") or self._consumer(scope)

        try:
            request_size = int(headers.get("content-length") or 0) or probe.request_bytes
        except ValueError:
            request_size = probe.request_bytes
        try:
            response_size = probe.response_bytes or int(probe.response_headers.get("content-length") or 0)
        except ValueError:
            response_size = probe.response_bytes

        self.collector.record_metrics(
            method, route, status, elapsed_ms, request_size, response_size, consumer
        )

        # Errors the app reported with capture_exception, now that the status
        # they were answered with is known.
        for row in errors.settle_handled(state, status, consumer):
            self.collector.record_error(row)

        if cfg.capture_errors and not state.get("error_recorded"):
            link_state = {**state, "consumer": consumer}
            if raised is not None:
                state["error_recorded"] = True
                self.collector.record_error(
                    errors.exception_row(
                        raised,
                        method=method,
                        route=route,
                        status=status if status >= 500 else 500,
                        state=link_state,
                    )
                )
            elif status >= 400:
                # Most 4xx never raise through here: FastAPI turns an
                # HTTPException or a validation failure into a response inside
                # the app. The Node plugin records those too, and without them
                # every client error was invisible.
                state["error_recorded"] = True
                content_type = probe.response_headers.get("content-type")
                body = bytes(probe.error_body)
                self.collector.record_error(
                    errors.response_row(
                        method=method,
                        route=route,
                        status=status,
                        state=link_state,
                        body=body,
                        content_type=content_type,
                        error_type=_error_type(body, content_type),
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
            "clientIp": _client_ip(scope, headers),
            "host": headers.get("host"),
        }

        query = scope.get("query_string") or b""
        if query:
            try:
                pairs = parse_qsl(query.decode("latin-1"), keep_blank_values=True)
                row["queryParams"] = mask_mapping(dict(pairs), cfg.mask_fields)
            except Exception:
                pass

        if cfg.log_request_headers:
            row["requestHeaders"] = mask_mapping(headers, cfg.mask_headers)

        if cfg.log_request_body and probe.request_body:
            row["requestBody"] = mask_body(bytes(probe.request_body), cfg.mask_fields, cfg.max_body_bytes)

        if cfg.log_response_body and probe.response_body:
            row["responseBody"] = mask_body(bytes(probe.response_body), cfg.mask_fields, cfg.max_body_bytes)

        attributes = state.get("attributes")
        if attributes:
            row["attributes"] = attributes
        if state.get("trace_id"):
            row["traceId"] = state["trace_id"]

        self.collector.record_request(row)
        trace = request_trace(state, method, route, status, elapsed_ms)
        if trace:
            self.collector.record_trace(trace)


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
