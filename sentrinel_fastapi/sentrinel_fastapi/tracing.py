# Shared with sentrinel_django: edit it there, then run scripts/sync-python-core.py.
"""Spans: why a request was slow, not just that it was.

A request row says a page took 900 ms. A trace says 740 of those were one
query, it ran four times, and the third one blocked. That is the difference
between knowing there is a problem and knowing where it is.

Spans nest under the request's server span automatically, because the current
span is held in a ``ContextVar`` rather than passed around — the same reason
the log handler can stamp a request id without every call site knowing about
it. Under ASGI — FastAPI, or Django's async views — one thread interleaves
many requests, and a thread local would attach a span to the wrong trace.

Everything here is inert outside a request. A span recorded with no trace to
belong to would be a root that answers nothing, and raising instead would make
tracing something you have to guard.
"""

from __future__ import annotations

import functools
import inspect
import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Iterator, TypeVar

from . import context
from .trace import generate_span_id

#: The span a new span should hang off. The request's server span, until a
#: `span()` block opens and becomes the parent for anything inside it.
_current_span: ContextVar[str | None] = ContextVar("sentrinel_span", default=None)

F = TypeVar("F", bound=Callable[..., Any])

#: A trace carries the work of one request. Past this the cost stops being
#: worth it — a loop that opens a span per row produces a waterfall nobody can
#: read, and the batch is refused by the API at 1000.
MAX_SPANS = 500


def current_span_id() -> str | None:
    """The span anything recorded right now would hang off."""
    span = _current_span.get()
    if span:
        return span
    state = context.current()
    return state.get("span_id") if state else None


@contextmanager
def span(
    name: str,
    attributes: dict[str, Any] | None = None,
    kind: str = "INTERNAL",
) -> Iterator[dict[str, Any]]:
    """Time a block of work and file it under this request's trace.

    ```python
    from sentrinel_fastapi import span

    with span("charge.card", {"gateway": "stripe"}) as s:
        result = gateway.charge(order)
        s["attributes"]["authorised"] = result.ok
    ```

    The yielded dict is the span: add attributes to it as you learn them. An
    exception passing through is recorded on the span and re-raised — a span
    that swallowed the error would be worse than no span.
    """
    state = context.current()
    if state is None:
        # No request, no trace to belong to. Yield a throwaway so the calling
        # code reads the same in a background job as in a request handler.
        yield {"attributes": dict(attributes or {})}
        return

    spans: list[dict[str, Any]] = state.setdefault("spans", [])
    parent = current_span_id()
    span_id = generate_span_id()
    started = time.perf_counter()

    record: dict[str, Any] = {
        "id": span_id,
        "traceId": state.get("trace_id"),
        "parentId": parent,
        "name": str(name)[:255],
        "kind": kind,
        "startTime": _now_iso(),
        "attributes": dict(attributes or {}),
        "statusCode": "OK",
    }

    token = _current_span.set(span_id)
    try:
        yield record
    except Exception as exc:
        record["statusCode"] = "ERROR"
        record["statusMessage"] = f"{type(exc).__name__}: {exc}"[:500]
        raise
    finally:
        _current_span.reset(token)
        record["durationMs"] = round((time.perf_counter() - started) * 1000, 3)
        record["endTime"] = _now_iso()
        # Bounded, and the cap is counted rather than silent: a waterfall
        # missing its tail with no explanation is a bug report.
        if len(spans) < MAX_SPANS:
            spans.append(record)
        else:
            state["spans_dropped"] = state.get("spans_dropped", 0) + 1


def traced(name: str | None = None, attributes: dict[str, Any] | None = None) -> Callable[[F], F]:
    """Decorator form, for when the whole function is the unit of work.

    ```python
    @traced("pricing.quote")
    def quote(order):
        ...
    ```

    Defaults to ``module.qualname``, so an undecorated-looking waterfall still
    names something you can find.

    Works on ``async def`` too. Wrapping a coroutine function in the sync form
    would time how long it took to *create* the coroutine — microseconds — and
    the span would close before any of the work ran.
    """

    def decorate(fn: F) -> F:
        label = name or f"{getattr(fn, '__module__', '?')}.{getattr(fn, '__qualname__', fn.__name__)}"

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                with span(label, attributes):
                    return await fn(*args, **kwargs)

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with span(label, attributes):
                return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorate


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def request_trace(
    state: dict[str, Any], method: str, route: str, status: int, elapsed_ms: float
) -> dict[str, Any] | None:
    """The trace payload for one request, or None when there is nothing to ship.

    Only when the request recorded child spans: a trace holding nothing but its
    own server span repeats what the request row already says, and would double
    the rows for every request in exchange for nothing.
    """
    spans = state.get("spans") or []
    if not spans:
        return None

    start_iso = state.get("started_iso") or _now_iso()
    end_iso = _now_iso()
    root: dict[str, Any] = {
        "id": state.get("span_id"),
        "traceId": state.get("trace_id"),
        # The caller's span when one sent a traceparent, so the phone's request
        # and this server's work share a waterfall.
        "parentId": state.get("parent_span_id"),
        "name": f"{method} {route}",
        "kind": "SERVER",
        "startTime": start_iso,
        "endTime": end_iso,
        "durationMs": round(elapsed_ms, 3),
        "statusCode": "ERROR" if status >= 500 else "OK",
        "attributes": {
            "http.method": method,
            "http.route": route,
            "http.status_code": status,
            **(state.get("attributes") or {}),
        },
    }
    dropped = state.get("spans_dropped")
    if dropped:
        root["attributes"]["sentrinel.spans_dropped"] = dropped

    return {
        "traceId": state.get("trace_id"),
        "requestLogId": state.get("request_id"),
        "name": f"{method} {route}",
        "startTime": start_iso,
        "endTime": end_iso,
        "durationMs": round(elapsed_ms, 3),
        "statusCode": status,
        "spans": [root, *spans],
    }

