"""Turning a URL into the endpoint it belongs to.

``/orders/1042`` and ``/orders/1043`` are one endpoint. Grouping by the raw
path instead produces one endpoint row per id — an unbounded table and an
"active endpoints" count in the thousands for an app with thirty routes.

Django already knows the answer, so ask it first: ``resolver_match.route`` is
the pattern that matched (``orders/<int:pk>/``). The heuristic below is only
for what the resolver cannot name — a path that 404'd before matching anything,
or a very old Django.
"""

from __future__ import annotations

import re
from typing import Any

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_NUMERIC = re.compile(r"^\d+$")
_LONG_HEX = re.compile(r"^[0-9a-f]{12,}$", re.I)

#: A segment is an id when it is long enough *and* contains a digit.
#
# The digit is the whole trick. English route words — "facade", "settings",
# "profile" — are long enough to trip a length check and contain no digits, so
# a length rule alone turns them into wildcards and merges unrelated endpoints.
_ID_MIN_LEN = 8


def _looks_like_id(segment: str) -> bool:
    if _NUMERIC.match(segment) or _UUID.match(segment) or _LONG_HEX.match(segment):
        return True
    if len(segment) >= _ID_MIN_LEN and any(c.isdigit() for c in segment):
        return True
    return False


def template_path(path: str) -> str:
    """Collapse id-shaped segments to ``:id``."""
    if not path:
        return path
    parts = path.split("/")
    return "/".join(":id" if _looks_like_id(p) else p for p in parts)


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
