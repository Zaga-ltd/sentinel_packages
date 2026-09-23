# Shared with sentrinel_django: edit it there, then run scripts/sync-python-core.py.
"""Collapsing ids out of a URL, for when the framework cannot name the route.

``/orders/1042`` and ``/orders/1043`` are one endpoint. Grouping by the raw
path instead produces one endpoint row per id — an unbounded table and an
"active endpoints" count in the thousands for an app with thirty routes.

Every framework package asks its router first; this is only for what the router
cannot name — a path that 404'd before matching anything, or a framework with
no route to read.
"""

from __future__ import annotations

import re

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
