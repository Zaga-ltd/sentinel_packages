"""Error rows, in the shape the ingest API accepts.

Two ways a request becomes an error, and both have to produce the same row:

* **An exception** — the only source with a stack trace, so it always wins.
* **A 4xx or 5xx response with no exception behind it** — a validation
  failure, a permission check, a framework's own 404. Most client errors are
  responses, not raises, and skipping them left the Errors page with server
  errors only. The message comes from the response body when it says one.

This is the rule the Node plugin follows, so an endpoint reported from a Python
service and from a Node service is counted the same way.
"""

from __future__ import annotations

import json
import traceback
from datetime import datetime, timezone
from http import HTTPStatus
from typing import Any

#: How much of a response body is read for its error message. The message is
#: the part a person reads; a 5 MB error page is not a better one.
BODY_PEEK_BYTES = 16_384


def reason_phrase(status: int) -> str:
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return "Error" if status >= 500 else "Client Error"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _links(state: dict[str, Any] | None) -> dict[str, Any]:
    """What lets an occurrence open the request that produced it, and its trace."""
    state = state or {}
    return {
        "consumerIdentifier": state.get("consumer"),
        "timestamp": _now_iso(),
        "requestLogId": state.get("request_id"),
        "traceId": state.get("trace_id"),
        "attributes": state.get("attributes") or None,
    }


def exception_row(
    exc: BaseException,
    *,
    method: str,
    route: str,
    status: int = 500,
    state: dict[str, Any] | None = None,
    status_message: str | None = None,
) -> dict[str, Any]:
    """An error row for an exception, with its stack."""
    return {
        "method": method,
        # The route, not the URL. Endpoints are registered by whatever an error
        # reports here, so sending the raw path registers a second endpoint for
        # the one the requests already created — /boom/ beside /boom — and
        # splits an endpoint's error count away from its traffic.
        "path": route,
        "statusCode": status,
        "statusMessage": status_message or reason_phrase(status),
        "errorType": type(exc).__name__,
        "errorMessage": str(exc)[:2000],
        "stackTrace": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[:20_000],
        **_links(state),
    }


def message_from_body(body: bytes | None, content_type: str | None) -> str | None:
    """The message a JSON error body carries, if it carries one.

    Reads the keys frameworks actually use: ``detail`` (FastAPI, Django REST
    framework), ``message`` and ``error`` (almost everything else). A list of
    validation problems becomes one line per field, which is what a person
    scanning the Errors page needs.
    """
    if not body:
        return None
    if content_type and "json" not in content_type.lower():
        text = body[:500].decode("utf-8", "replace").strip()
        # Plain-text bodies are often the message itself; HTML pages are not.
        return text if text and not text.lstrip().startswith("<") else None
    try:
        data = json.loads(body[:BODY_PEEK_BYTES].decode("utf-8", "replace"))
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    for key in ("detail", "message", "error"):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value[:2000]
        if isinstance(value, list) and value:
            return validation_summary(value)[:2000]
        if isinstance(value, dict) and value:
            inner = value.get("message") or value.get("detail")
            if isinstance(inner, str):
                return inner[:2000]
    return None


def validation_summary(problems: list[Any]) -> str:
    """``[{"loc": ["body", "email"], "msg": "field required"}]`` → ``body.email: field required``."""
    lines = []
    for p in problems[:20]:
        if isinstance(p, dict):
            loc = p.get("loc")
            where = ".".join(str(x) for x in loc) if isinstance(loc, (list, tuple)) else ""
            msg = p.get("msg") or p.get("message") or json.dumps(p, default=str)[:200]
            lines.append(f"{where}: {msg}" if where else str(msg))
        else:
            lines.append(str(p)[:200])
    return "; ".join(lines)


def response_row(
    *,
    method: str,
    route: str,
    status: int,
    state: dict[str, Any] | None = None,
    body: bytes | None = None,
    content_type: str | None = None,
    error_type: str | None = None,
) -> dict[str, Any]:
    """An error row for a 4xx/5xx response nothing raised through us."""
    return {
        "method": method,
        "path": route,
        "statusCode": status,
        "statusMessage": reason_phrase(status),
        "errorType": error_type,
        "errorMessage": message_from_body(body, content_type) or reason_phrase(status),
        **_links(state),
    }
