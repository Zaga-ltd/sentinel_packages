"""Sentrinel for Django.

Two lines of settings and every request, error and log line reaches Sentrinel::

    MIDDLEWARE = ["sentrinel_django.SentrinelMiddleware", ...]

    SENTRINEL = {
        "SERVER_URL": "https://api.sentrinel.dev",
        "APP_NAME": "orders",
        "ENV": "prod",
        "API_KEY": os.environ["SENTRINEL_API_KEY"],
    }

Everything else — bodies, sampling, masking, custom metrics — is optional and
documented at https://docs.sentrinel.dev/reference/django/
"""

from __future__ import annotations

from typing import Any

from .collector import set_config_loader
from .config import Config, load
from .context import add_context, set_consumer
from .logs import SentrinelLogHandler
from .metrics import count, gauge, histogram, registry
from .middleware import SentrinelMiddleware
from .outbound import SentrinelSession, async_httpx_transport, httpx_transport, trace_headers
from .settings import from_django_settings
from .trace import parse_traceparent, traceparent_for
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

default_app_config = "sentrinel_django.apps.SentrinelConfig"

# A collector created before the middleware — by a log line at startup, by the
# tunnel — reads the SENTRINEL block from settings rather than the environment
# alone.
set_config_loader(from_django_settings)


def capture_exception(
    exc: BaseException,
    *,
    request: Any = None,
    attributes: dict[str, Any] | None = None,
) -> None:
    """Report an exception you handled.

    An exception you caught and dealt with never reaches the middleware, and
    "dealt with" often means a degraded path the user still noticed. This puts
    it in front of you::

        try:
            charge(order)
        except PaymentError as exc:
            capture_exception(exc, attributes={"order_id": order.id})
            return fallback()
    """
    from . import context
    from .collector import get_collector

    collector = get_collector()
    if not collector.config.configured or not collector.config.capture_errors:
        return

    state = context.current() or {}
    merged = dict(state.get("attributes") or {})
    merged.update(attributes or {})
    try:
        from .errors import defer_handled, exception_row

        row = exception_row(
            exc,
            method=getattr(request, "method", "GET") if request is not None else "GET",
            route=_route_of(request),
            status=500,
            status_message="Handled",
            state={**state, "attributes": merged},
        )
        if state:
            # Inside a request the response decides the status, and a handled
            # error the view answers with a 503 is one error, not two: the
            # middleware would otherwise add a row for the response as well.
            state["error_recorded"] = True
            defer_handled(state, row)
        else:
            collector.record_error(row)
    except Exception as err:
        collector._debug("capture_exception failed", err)


def _route_of(request: Any) -> str:
    """The endpoint an error belongs to — the route, matching the request rows."""
    if request is None:
        return "/"
    from .routes import route_for

    path = getattr(request, "path", "") or "/"
    try:
        return route_for(request, path)
    except Exception:
        return path


def current_trace() -> dict[str, str | None]:
    """The trace this request belongs to, or empty outside one.

    ``{"trace_id": …, "span_id": …, "parent_span_id": …}``. Useful for putting
    the trace id in an error page or a support ticket, so a user's complaint
    leads straight to the timeline.
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

    The chain only continues if each service passes it on. A Django service
    that reads `traceparent` and does not forward it joins the mobile app's
    trace and then ends it, which looks like the downstream service never ran::

        requests.post(url, json=payload, headers=outgoing_headers())

    Outside a request this returns the headers unchanged — there is no trace to
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

    The background thread does this on a timer; call it directly at the end of
    a management command or a Celery task, where the process may exit before
    the next tick.
    """
    from .collector import get_collector

    try:
        get_collector().flush()
    except Exception:
        pass
