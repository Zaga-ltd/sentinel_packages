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

import traceback
from typing import Any

from .config import Config, load
from .context import add_context, set_consumer
from .logs import SentrinelLogHandler
from .metrics import count, gauge, histogram, registry
from .middleware import SentrinelMiddleware

__all__ = [
    "SentrinelMiddleware",
    "SentrinelLogHandler",
    "add_context",
    "set_consumer",
    "capture_exception",
    "count",
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
    from datetime import datetime, timezone

    from . import context
    from .collector import get_collector

    collector = get_collector()
    if not collector.config.configured or not collector.config.capture_errors:
        return

    state = context.current() or {}
    merged = dict(state.get("attributes") or {})
    merged.update(attributes or {})

    try:
        collector.record_error(
            {
                "method": getattr(request, "method", "GET") if request is not None else "GET",
                "path": _route_of(request),
                "statusCode": 500,
                "statusMessage": "Handled",
                "errorType": type(exc).__name__,
                "errorMessage": str(exc)[:2000],
                "stackTrace": "".join(
                    traceback.format_exception(type(exc), exc, exc.__traceback__)
                )[:20_000],
                "consumerIdentifier": state.get("consumer"),
                "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "requestLogId": state.get("request_id"),
                "traceId": state.get("trace_id"),
                "attributes": merged or None,
            }
        )
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
