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
    customer, the feature flag that was on. Called from view code::

        from sentrinel_django import add_context
        add_context(tier="enterprise", customer_id=org.id)
    """
    state = _current.get()
    if state is not None:
        state["attributes"].update(attributes)


def set_consumer(identifier: str | None) -> None:
    """Name the user this request belongs to, from inside a view.

    Useful when identity is only known after authentication middleware has run,
    or when it is not on ``request.user`` at all.
    """
    state = _current.get()
    if state is not None:
        state["consumer"] = identifier
