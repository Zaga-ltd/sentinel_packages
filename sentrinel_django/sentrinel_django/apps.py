"""Django app config.

Optional — the middleware works on its own. Adding ``sentrinel_django`` to
``INSTALLED_APPS`` additionally hooks ``got_request_exception``, which catches
exceptions that never reach ``process_exception``: those raised inside another
middleware, or inside a template.
"""

from __future__ import annotations

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
        from .errors import exception_row
        from .middleware import status_for_exception

        collector.record_error(
            exception_row(
                exc,
                method=getattr(request, "method", "GET") if request else "GET",
                # The route, so this error attaches to the endpoint the request
                # rows already registered rather than creating a twin.
                route=_route_of(request),
                status=status_for_exception(exc),
                state=state,
            )
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

