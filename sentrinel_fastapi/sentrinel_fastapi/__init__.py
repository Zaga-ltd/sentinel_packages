"""Sentrinel for FastAPI — and Starlette, and any ASGI app built on them.

One middleware and every request, error and log line reaches Sentrinel::

    from fastapi import FastAPI
    from sentrinel_fastapi import SentrinelMiddleware

    app = FastAPI()
    app.add_middleware(
        SentrinelMiddleware,
        server_url="https://api.sentrinel.dev",
        app_name="orders",
        env="prod",
        api_key=os.environ["SENTRINEL_API_KEY"],
    )

Everything else — bodies, sampling, masking, spans, custom metrics — is
optional and documented at https://docs.sentrinel.dev/reference/fastapi/
"""

from __future__ import annotations

from typing import Any

from .config import Config, load
from .context import add_context, set_consumer
from .logs import SentrinelLogHandler
from .metrics import count, gauge, histogram, registry
from .middleware import SentrinelMiddleware
from .outbound import SentrinelSession, async_httpx_transport, httpx_transport, trace_headers
from .trace import traceparent_for
from .tracing import current_span_id, span, traced
from .tunnel import sentrinel_tunnel

__all__ = [
    "SentrinelMiddleware",
    "SentrinelLogHandler",
    "add_context",
    "set_consumer",
    "capture_exception",
    "SentrinelSession",
    "httpx_transport",
    "async_httpx_transport",
    "count",
    "current_span_id",
    "current_trace",
    "sentrinel_tunnel",
    "span",
    "trace_headers",
    "traced",
    "outgoing_headers",
    "gauge",
    "histogram",
    "flush",
    "Config",
    "load",
    "registry",
    "__version__",
]

__version__ = "0.1.0"


def capture_exception(
    exc: BaseException,
    *,
    request: Any = None,
    attributes: dict[str, Any] | None = None,
) -> None:
    """Report an exception you handled.

    An exception you caught never reaches the middleware, and neither does one
    an exception handler turned into a response — FastAPI does that before the
    middleware sees anything. Call this from either place::

        @app.exception_handler(PaymentError)
        async def payment_failed(request, exc):
            capture_exception(exc, request=request, attributes={"order_id": exc.order_id})
            return JSONResponse({"detail": "payment failed"}, status_code=402)

    The error is recorded with the status of the response that follows —
    the 402 above — and that response is not counted as a second error.
    """
    from . import context
    from .collector import get_collector
    from .errors import defer_handled, exception_row

    collector = get_collector()
    if not collector.config.configured or not collector.config.capture_errors:
        return

    state = context.current() or {}
    merged = dict(state.get("attributes") or {})
    merged.update(attributes or {})

    try:
        row = exception_row(
            exc,
            method=_method_of(request, state),
            route=_route_of(request, state),
            status=500,
            status_message="Handled",
            state={**state, "attributes": merged},
        )
        if state:
            # Inside a request the response decides the status: the handler
            # above answers 402, so the error is a 402. And the response is not
            # recorded as a second error beside it.
            state["error_recorded"] = True
            defer_handled(state, row)
        else:
            collector.record_error(row)
    except Exception as err:
        collector._debug("capture_exception failed", err)


def _method_of(request: Any, state: dict[str, Any]) -> str:
    if request is not None:
        return getattr(request, "method", "GET") or "GET"
    scope = state.get("scope") or {}
    return scope.get("method", "GET")


def _route_of(request: Any, state: dict[str, Any]) -> str:
    """The endpoint an error belongs to — the route, matching the request rows."""
    from .routes import route_for, template_path

    scope = getattr(request, "scope", None) or state.get("scope")
    path = state.get("path") or (scope or {}).get("path") or "/"
    if not scope:
        return template_path(path)
    try:
        return route_for(scope, path, state.get("entry_root_path") or "")
    except Exception:
        return path


def current_trace() -> dict[str, str | None]:
    """The trace this request belongs to, or empty outside one.

    ``{"trace_id": …, "span_id": …, "parent_span_id": …}``. Useful for putting
    the trace id in an error response or a support ticket, so a user's
    complaint leads straight to the timeline.
    """
    from . import context

    state = context.current() or {}
    return {
        "trace_id": state.get("trace_id"),
        "span_id": state.get("span_id"),
        "parent_span_id": state.get("parent_span_id"),
    }


def outgoing_headers(headers: dict[str, str] | None = None) -> dict[str, str]:
    """Add this request's trace context to headers you are about to send.

    The chain only continues if each service passes it on::

        await client.post(url, json=payload, headers=outgoing_headers())

    ``httpx_transport()`` does this for every call a client makes. Outside a
    request this returns the headers unchanged — there is no trace to
    propagate, and inventing one would create a root that belongs to nobody.
    """
    from . import context

    out = dict(headers or {})
    state = context.current()
    if not state or not state.get("trace_id") or not state.get("span_id"):
        return out
    out.setdefault("traceparent", traceparent_for(state["trace_id"], state["span_id"]))
    return out


def flush() -> None:
    """Send everything buffered now.

    The background thread does this on a timer; call it at the end of a script
    or a worker job, where the process may exit before the next tick.
    """
    from .collector import get_collector

    try:
        get_collector().flush()
    except Exception:
        pass
