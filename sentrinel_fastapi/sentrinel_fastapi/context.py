# Shared with sentrinel_django: edit it there, then run scripts/sync-python-core.py.
"""Per-request state, so a log line knows which request wrote it.

``contextvars`` rather than thread locals: it is correct under WSGI threads and
under ASGI, where one thread interleaves many requests and a thread local would
hand a log line the wrong request's id.
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar
from typing import Any

_current: ContextVar[dict[str, Any] | None] = ContextVar("sentrinel_request", default=None)


def begin(
    request_id: str | None = None,
    consumer: str | None = None,
    trace_id: str | None = None,
    span_id: str | None = None,
    parent_span_id: str | None = None,
) -> dict[str, Any]:
    state: dict[str, Any] = {
        "request_id": request_id or str(uuid.uuid4()),
        "consumer": consumer,
        "trace_id": trace_id,
        # This request's own server span, and the caller's span when one sent a
        # traceparent. Both travel on every log line written during the request.
        "span_id": span_id,
        "parent_span_id": parent_span_id,
        "logs": [],
        "attributes": {},
        "seq": 0,
    }
    _current.set(state)
    return state


def current() -> dict[str, Any] | None:
    return _current.get()


def end() -> dict[str, Any] | None:
    state = _current.get()
    _current.set(None)
    return state


def add_context(**attributes: Any) -> None:
    """Attach business context to this request's row, error and logs.

    This is what turns a request row into a canonical wide event: the tier, the
    customer, the feature flag that was on. Called from a request handler::

        from sentrinel_fastapi import add_context
        add_context(tier="enterprise", customer_id=org.id)
    """
    state = _current.get()
    if state is not None:
        state["attributes"].update(attributes)


def set_consumer(identifier: str | None) -> None:
    """Name the user this request belongs to, from inside a request handler.

    Useful when identity is only known after authentication middleware has run,
    or when it is not on ``request.user`` at all.
    """
    state = _current.get()
    if state is not None:
        state["consumer"] = identifier


#: What a phone or browser may name itself as without TRUST_CLIENT_CONSUMER.
GUEST_PREFIX = "guest:"

#: ``x-sentrinel-consumer`` and ``x-sentrinel-device`` are whatever the caller
#: chose to send, so they are cut to a length an identifier plausibly has.
_MAX_CLIENT_ID = 255


def client_consumer(value: Any, trust: bool = False) -> str | None:
    """The consumer a phone or browser named in ``x-sentrinel-consumer``.

    The middleware falls back to it only when the server knows nobody — the
    resolver and the signed-in user come first. Anyone can send any header, so
    by default only a ``guest:`` id is taken: it names an install, not an
    account, and a forged one mislabels anonymous traffic at worst. Any other
    value, taken on the client's word, would let a caller file its requests and
    errors under a real user. ``trust`` lifts that for a backend whose callers
    are its own.
    """
    ident = str(value or "").strip()[:_MAX_CLIENT_ID]
    if not ident:
        return None
    if not trust and (not ident.startswith(GUEST_PREFIX) or ident == GUEST_PREFIX):
        return None
    return ident


def device_id(value: Any) -> str | None:
    """The install id a phone or browser sent in ``x-sentrinel-device``."""
    return str(value or "").strip()[:_MAX_CLIENT_ID] or None
