"""Turning a URL into the endpoint it belongs to.

``/orders/1042`` and ``/orders/1043`` are one endpoint. Grouping by the raw
path instead produces one endpoint row per id — an unbounded table and an
"active endpoints" count in the thousands for an app with thirty routes.

Django already knows the answer, so ask it first: ``resolver_match.route`` is
the pattern that matched (``orders/<int:pk>/``). The shared id heuristic in
``route_template`` is only for what the resolver cannot name — a path that
404'd before matching anything, or a very old Django.
"""

from __future__ import annotations

import re
from typing import Any

from .route_template import template_path

__all__ = ["normalise_django_route", "route_for", "template_path"]


def normalise_django_route(route: str) -> str:
    """Render Django's own pattern the way the rest of Sentrinel writes routes.

    ``orders/<int:pk>/`` becomes ``/orders/:pk``. Keeping Django's spelling
    would be defensible in isolation and wrong in the product: the same
    endpoint reported by the Node plugin and by Django would appear as two
    rows that never add up.
    """
    if not route:
        return route
    # Named groups first: `(?P<year>…)` contains angle brackets, so running the
    # converter rule ahead of it rewrites the group's own name and leaves the
    # regex body behind.
    out = re.sub(r"\(\?P<([^>]+)>[^)]*\)", r":\1", route)          # re_path() groups
    out = re.sub(r"<(?:[^:>]+:)?([^>]+)>", r":\1", out)             # path() converters
    out = re.sub(r"[\^$]", "", out)                                # regex anchors
    if not out.startswith("/"):
        out = "/" + out
    if len(out) > 1 and out.endswith("/"):
        out = out[:-1]
    return out or "/"


def route_for(request: Any, path: str) -> str:
    """The endpoint key for this request: Django's route when it has one."""
    match = getattr(request, "resolver_match", None)
    route = getattr(match, "route", None) if match else None
    if route:
        return normalise_django_route(route)
    return template_path(path)
