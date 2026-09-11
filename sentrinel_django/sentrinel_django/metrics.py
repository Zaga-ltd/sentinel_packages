"""Custom metrics: the numbers only your application knows.

Tokens spent, revenue booked, queue depth, jobs retried. Tracing says why a
call was slow; it cannot say what it cost, because nothing in a span is a
number you asked to be summed.

An increment does not touch the network. It mutates a map, and the whole map is
folded into one row per series per flush — which is what makes ``count()`` safe
to call in a hot loop. A metrics API you have to be careful with is one people
stop using.

Mirrors ``@sentrinel/plugin``'s registry deliberately, including its caps: a
metric recorded from a Django service and from a Node service must mean the
same thing and fold the same way, or the chart adds up two different things.
"""

from __future__ import annotations

import json
import math
import random
import threading
from typing import Any, Mapping

MAX_NAME = 128
MAX_LABEL_KEYS = 12
MAX_LABEL_VALUE = 128

#: Distinct series held at once. Past this, new series are dropped rather than
#: growing without bound — a process that has invented ten thousand series has
#: a label bug, usually an id where a category belongs.
MAX_SERIES = 2_000

#: Raw values kept per histogram, for percentiles. Past this, samples are
#: replaced with decreasing probability so a percentile over a long window
#: stays representative instead of describing the first few seconds.
MAX_SAMPLES = 512


def canonical_labels(labels: Mapping[str, Any] | None) -> str:
    """Sorted, so ``{a,b}`` and ``{b,a}`` are one series.

    Without this, the same metric recorded from two call sites that happened to
    write the keys in a different order charts as two unrelated lines, and
    nothing tells you why the total is split in half.
    """
    if not labels:
        return "{}"
    out: dict[str, str] = {}
    for key in sorted(labels)[:MAX_LABEL_KEYS]:
        value = labels[key]
        if value is None:
            continue
        out[key] = str(value)[:MAX_LABEL_VALUE]
    return json.dumps(out, separators=(",", ":"))


def _percentile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        return 0.0
    idx = min(len(sorted_values) - 1, max(0, math.ceil(q * len(sorted_values)) - 1))
    return sorted_values[idx]


class MetricRegistry:
    def __init__(self) -> None:
        self._series: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self.dropped_series = 0

    def record(
        self,
        name: str,
        kind: str,
        value: float,
        labels: Mapping[str, Any] | None = None,
        unit: str | None = None,
    ) -> None:
        if not name or not isinstance(name, str):
            return
        try:
            value = float(value)
        except (TypeError, ValueError):
            return
        # NaN and Infinity would poison the sum for the whole window, and every
        # chart drawn from it afterwards.
        if not math.isfinite(value):
            return

        clean = name.strip()[:MAX_NAME]
        if not clean:
            return
        canon = canonical_labels(labels)
        key = f"{clean} {kind} {canon}"

        with self._lock:
            entry = self._series.get(key)
            if entry is None:
                if len(self._series) >= MAX_SERIES:
                    self.dropped_series += 1
                    return
                entry = self._series[key] = {
                    "name": clean, "kind": kind, "labels": canon, "unit": unit,
                    "count": 0, "sum": 0.0, "min": value, "max": value, "last": value,
                    "samples": [], "seen": 0,
                }
            entry["count"] += 1
            entry["sum"] += value
            entry["last"] = value
            entry["min"] = min(entry["min"], value)
            entry["max"] = max(entry["max"], value)
            if unit and not entry["unit"]:
                entry["unit"] = unit

            if kind == "histogram":
                entry["seen"] += 1
                samples = entry["samples"]
                if len(samples) < MAX_SAMPLES:
                    samples.append(value)
                else:
                    j = random.randrange(entry["seen"])
                    if j < MAX_SAMPLES:
                        samples[j] = value

    def drain(self, now_iso: str) -> list[dict[str, Any]]:
        """Take everything buffered and reset.

        Gauges reset with the rest: a gauge that stops being reported should
        leave a gap in the chart rather than a flat line implying its last
        value is still true.
        """
        with self._lock:
            series, self._series = self._series, {}
        out = []
        for s in series.values():
            samples = sorted(s["samples"])
            out.append(
                {
                    "name": s["name"], "kind": s["kind"], "labels": s["labels"], "unit": s["unit"],
                    "count": s["count"], "sum": s["sum"], "min": s["min"], "max": s["max"],
                    "last": s["last"],
                    "p50": _percentile(samples, 0.50),
                    "p95": _percentile(samples, 0.95),
                    "p99": _percentile(samples, 0.99),
                    "timestamp": now_iso,
                }
            )
        return out

    @property
    def size(self) -> int:
        return len(self._series)


_registry = MetricRegistry()


def registry() -> MetricRegistry:
    return _registry


def count(name: str, value: float = 1, labels: Mapping[str, Any] | None = None, unit: str | None = None) -> None:
    """Add to a running total: tokens, revenue, retries, items sold.

    Safe in a hot loop — increments fold in memory, and one row per series
    leaves per flush.
    """
    _registry.record(name, "counter", value, labels, unit)


def gauge(name: str, value: float, labels: Mapping[str, Any] | None = None, unit: str | None = None) -> None:
    """Report a level that goes up and down: queue depth, connections.

    The last value in a flush window wins — a gauge is a reading, not a total.
    """
    _registry.record(name, "gauge", value, labels, unit)


def histogram(name: str, value: float, labels: Mapping[str, Any] | None = None, unit: str | None = None) -> None:
    """Record a distribution: cost per call, batch size, time in a queue.

    Percentiles come back with it, which is the point — an average hides the
    one call that cost fifty times the rest.
    """
    _registry.record(name, "histogram", value, labels, unit)
