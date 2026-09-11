"""Masking, applied in this process before anything is buffered.

The ordering matters more than the patterns do: a value that is masked at send
time has already been sat in memory, in a buffer that might be dumped by a
crash handler. Masking on the way *in* means the secret never exists inside
Sentrinel's data structures at all.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Mapping, Pattern

from .config import MASK_VALUE


def _matches(name: str, patterns: Iterable[Pattern[str]]) -> bool:
    return any(p.search(name) for p in patterns)


def mask_mapping(
    values: Mapping[str, Any] | None, patterns: Iterable[Pattern[str]]
) -> dict[str, Any] | None:
    """Mask matching keys of a flat mapping — headers, query parameters."""
    if not values:
        return None
    patterns = list(patterns)
    return {k: (MASK_VALUE if _matches(k, patterns) else v) for k, v in values.items()}


def mask_structure(value: Any, patterns: Iterable[Pattern[str]], _depth: int = 0) -> Any:
    """Walk a decoded body and mask matching keys at any depth.

    Depth is bounded because the input is caller-controlled: a deeply nested
    body should cost a truncated mask, not a RecursionError inside somebody's
    request handler.
    """
    if _depth > 12:
        return value
    patterns = list(patterns)
    if isinstance(value, Mapping):
        out = {}
        for k, v in value.items():
            out[k] = MASK_VALUE if _matches(str(k), patterns) else mask_structure(v, patterns, _depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [mask_structure(v, patterns, _depth + 1) for v in value]
    return value


def mask_body(raw: bytes | str | None, patterns: Iterable[Pattern[str]], max_bytes: int) -> str | None:
    """Return a bounded, masked body — or None when there is nothing to send.

    A body that is not JSON is kept as text and truncated. It is *not* masked
    field-by-field, because there are no fields to find: masking a form-encoded
    or binary body by pattern would be a guess that reads as a guarantee. When
    that matters, turn body capture off.
    """
    if raw is None:
        return None
    data = raw.encode("utf-8", "replace") if isinstance(raw, str) else raw
    if not data:
        return None

    truncated = len(data) > max_bytes
    clipped = data[:max_bytes]

    try:
        decoded = json.loads(clipped.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        text = clipped.decode("utf-8", "replace")
        return text + "…[truncated]" if truncated else text

    masked = mask_structure(decoded, patterns)
    try:
        return json.dumps(masked, default=str)
    except (TypeError, ValueError):
        return None
