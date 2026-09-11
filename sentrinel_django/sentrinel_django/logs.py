"""A logging handler, so the lines you already write reach Sentrinel.

Attached to Django's ``LOGGING`` it captures records the application emits and
ships them with the request they were written during — same request id, same
consumer, same trace. That correlation is the entire point: a log line without
the request that produced it is a sentence with no subject.

Lines written inside a request are held on the request's context and flushed
with it, so they arrive in order and carry its identity. Lines written outside
one — a management command, a worker — go straight to the collector.
"""

from __future__ import annotations

import logging
from typing import Any

from . import context
from .collector import get_collector

#: Levels Sentrinel stores. Anything finer is mapped down rather than dropped,
#: so a project logging at TRACE does not silently send nothing.
_LEVELS = {
    logging.CRITICAL: "error",
    logging.ERROR: "error",
    logging.WARNING: "warn",
    logging.INFO: "info",
    logging.DEBUG: "debug",
}

#: Attributes on a LogRecord that are the logging machinery, not the message.
#: Anything else a caller passed via `extra=` is context worth keeping.
_RESERVED = frozenset(
    """args asctime created exc_info exc_text filename funcName levelname levelno
    lineno module msecs message msg name pathname process processName relativeCreated
    stack_info thread threadName taskName""".split()
)


def _level_name(levelno: int) -> str:
    for threshold in (logging.CRITICAL, logging.ERROR, logging.WARNING, logging.INFO):
        if levelno >= threshold:
            return _LEVELS[threshold]
    return "debug"


class SentrinelLogHandler(logging.Handler):
    """Ships log records to Sentrinel.

    Add it to ``LOGGING``::

        LOGGING = {
            "version": 1,
            "handlers": {
                "sentrinel": {"class": "sentrinel_django.SentrinelLogHandler", "level": "INFO"},
            },
            "root": {"handlers": ["console", "sentrinel"], "level": "INFO"},
        }
    """

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._emit(record)
        except Exception:
            # Never call handleError's default, which prints to stderr for every
            # record: a broken telemetry handler would drown the real logs.
            pass

    def _emit(self, record: logging.LogRecord) -> None:
        collector = get_collector()
        if not collector.config.configured or not collector.config.capture_logs:
            return

        # Our own diagnostics must not be captured and shipped, which would
        # produce a line per failure per flush, forever.
        if record.name.startswith("sentrinel"):
            return

        line: dict[str, Any] = {
            "timestamp": _iso(record.created),
            "level": _level_name(record.levelno),
            # The unformatted message, so every occurrence of one log statement
            # groups together regardless of the values interpolated into it.
            "message": str(record.msg)[:10_000],
            "category": record.name[:255],
        }

        attributes = {k: v for k, v in record.__dict__.items() if k not in _RESERVED and not k.startswith("_")}
        if record.args:
            # The values that would have been interpolated are context, and
            # keeping them separately is what makes them filterable.
            attributes["args"] = list(record.args) if isinstance(record.args, tuple) else record.args
        if record.exc_info:
            attributes["exception"] = logging.Formatter().formatException(record.exc_info)[:8000]
        if attributes:
            line["attributes"] = attributes

        state = context.current()
        if state is not None:
            line["requestId"] = state.get("request_id")
            line["consumerIdentifier"] = state.get("consumer")
            if state.get("trace_id"):
                line["traceId"] = state["trace_id"]
            if state.get("span_id"):
                line["spanId"] = state["span_id"]
            line["seq"] = state["seq"]
            state["seq"] += 1
            # Held, not sent: the middleware stamps the consumer that the view
            # may only have established after this line was written.
            state["logs"].append(line)
        else:
            collector.record_logs([line])


def _iso(epoch: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")
