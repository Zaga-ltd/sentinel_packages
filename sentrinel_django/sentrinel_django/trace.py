"""W3C trace context, so a request that started elsewhere stays one trace.

The Flutter and browser SDKs put a `traceparent` header on every call they
make. If the server ignores it, the app's request and the server's request are
two unrelated rows and the timeline that shows a tap causing database work does
not exist — which is the single feature that makes mobile monitoring here worth
more than a crash reporter.

Parsing matches `@sentrinel/plugin` exactly, tolerant forms included: the same
header reaching a Node service and a Django service must produce the same trace
id, or the two halves still do not join.
"""

from __future__ import annotations

import os
import re
from typing import NamedTuple

#: 00-<32 hex trace>-<16 hex span>-<2 hex flags>
_W3C = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$", re.I)
_BARE_TRACE = re.compile(r"^[0-9a-f]{32}$", re.I)
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)


class TraceContext(NamedTuple):
    trace_id: str
    #: The caller's span, when it sent a full traceparent. Our server span's parent.
    parent_span_id: str | None


def parse_traceparent(header: str | None) -> TraceContext | None:
    """Read an incoming header, or None when there is nothing usable in it."""
    if not header:
        return None
    trimmed = header.strip()

    m = _W3C.match(trimmed)
    if m:
        return TraceContext(m.group(1).lower(), m.group(2).lower())
    if _BARE_TRACE.match(trimmed):
        return TraceContext(trimmed.lower(), None)
    if _UUID.match(trimmed):
        return TraceContext(trimmed.replace("-", "").lower(), None)
    return None


def generate_trace_id() -> str:
    return os.urandom(16).hex()


def generate_span_id() -> str:
    return os.urandom(8).hex()


def traceparent_for(trace_id: str, span_id: str, sampled: bool = True) -> str:
    """Build the header to send onward, so the chain continues past this service."""
    return f"00-{trace_id}-{span_id}-{'01' if sampled else '00'}"
