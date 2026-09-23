"""Turning a URL into the endpoint it belongs to.

``/orders/1042`` and ``/orders/1043`` are one endpoint. The router already knows
which, so ask it first. FastAPI records the route it matched on the scope
(``scope["route"]``, with its ``path_format``: ``/orders/{order_id}``); plain
Starlette records the endpoint, and the route is found from that. The shared id
heuristic is only for what no router can name — a path that 404'd before
matching anything, or an ASGI framework with no router to read.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from .route_template import template_path

__all__ = ["normalise_route", "route_for", "template_path"]

#: ``{order_id}`` and ``{file_path:path}`` — a parameter with an optional converter.
_PARAM = re.compile(r"\{([^}:]+)(?::[^}]*)?\}")


def normalise_route(path_format: str) -> str:
    """Write a Starlette route the way the rest of Sentrinel writes routes.

    ``/orders/{order_id}`` becomes ``/orders/:order_id``. The same endpoint
    reported by the Node plugin, by Django and by FastAPI has to be one row, or
    the three never add up.
    """
    if not path_format:
        return "/"
    out = _PARAM.sub(r":\1", path_format)
    if not out.startswith("/"):
        out = "/" + out
    if len(out) > 1 and out.endswith("/"):
        out = out[:-1]
    return out


def _mount_prefix(scope: dict[str, Any], entry_root_path: str) -> str:
    """The path of any ``Mount`` the request went through.

    Starlette appends each mount's path to ``root_path`` as it routes, and the
    matched route's own path is relative to the innermost mount. Without the
    prefix, ``/v2/items/{id}`` on a mounted sub-application would be reported
    as ``/items/{id}`` and merge with the top-level route of that name.
    """
    root = scope.get("root_path") or ""
    if entry_root_path and root.startswith(entry_root_path):
        return root[len(entry_root_path):]
    return root if not entry_root_path else ""


def _find(routes: Iterable[Any], endpoint: Any, prefix: str) -> str | None:
    """The path a plain Starlette endpoint is registered at, through any mounts."""
    for route in routes or ():
        inner = getattr(route, "routes", None)
        path_format = getattr(route, "path_format", None) or getattr(route, "path", "")
        if inner is not None and not hasattr(route, "endpoint"):
            found = _find(inner, endpoint, prefix + (path_format or ""))
            if found is not None:
                return found
        elif getattr(route, "endpoint", None) is endpoint:
            return prefix + (path_format or "")
    return None


def route_for(scope: dict[str, Any], path: str, entry_root_path: str = "") -> str:
    """The endpoint key for this request: the router's route when it has one."""
    route = scope.get("route")
    path_format = getattr(route, "path_format", None) if route is not None else None
    if path_format:
        return normalise_route(_mount_prefix(scope, entry_root_path) + path_format)

    endpoint = scope.get("endpoint")
    router = scope.get("router")
    if endpoint is not None and router is not None:
        try:
            found = _find(getattr(router, "routes", ()), endpoint, "")
        except Exception:
            found = None
        if found:
            return normalise_route(found)

    return template_path(path or "/")
