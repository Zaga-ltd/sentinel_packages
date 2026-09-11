"""Django app config.

Optional — the middleware works on its own. Adding ``sentrinel_django`` to
``INSTALLED_APPS`` additionally hooks ``got_request_exception``, which catches
exceptions that never reach ``process_exception``: those raised inside another
middleware, or inside a template.
"""

from __future__ import annotations

import traceback
from typing import Any

from django.apps import AppConfig


class SentrinelConfig(AppConfig):
    name = "sentrinel_django"
    verbose_name = "Sentrinel"

    def ready(self) -> None:
        from django.core.signals import got_request_exception

        got_request_exception.connect(_on_exception, dispatch_uid="sentrinel_django")


def _on_exception(sender: Any, request: Any = None, **kwargs: Any) -> None:
    import sys

    from . import context
    from .collector import get_collector

    collector = get_collector()
    cfg = collector.config
    if not cfg.configured or not cfg.capture_errors:
        return

    exc_type, exc, tb = sys.exc_info()
    if exc is None:
        return

    state = context.current() or {}
    # The middleware's process_exception already recorded a view exception, and
    # this signal fires for the same one. Recording both would double every
    # error's occurrence count, which is the number people rank issues by.
    if state.get("error_recorded"):
        return
    state["error_recorded"] = True

    try:
        collector.record_error(
            {
                "method": getattr(request, "method", "GET") if request else "GET",
                # The route, so this error attaches to the endpoint the request
                # rows already registered rather than creating a twin.
                "path": _route_of(request),
                "statusCode": 500,
                "statusMessage": "Internal Server Error",
                "errorType": exc_type.__name__ if exc_type else "Error",
                "errorMessage": str(exc)[:2000],
                "stackTrace": "".join(traceback.format_exception(exc_type, exc, tb))[:20_000],
                "consumerIdentifier": state.get("consumer"),
                "timestamp": _now_iso(),
                "requestLogId": state.get("request_id"),
                "traceId": state.get("trace_id"),
                "attributes": state.get("attributes") or None,
            }
        )
    except Exception as err:
        collector._debug("signal error capture failed", err)


def _route_of(request: Any) -> str:
    if request is None:
        return "/"
    from .routes import route_for

    path = getattr(request, "path", "") or "/"
    try:
        return route_for(request, path)
    except Exception:
        return path


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
