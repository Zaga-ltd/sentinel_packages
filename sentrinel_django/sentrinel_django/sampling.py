"""Which requests are kept.

The rule is the one the TypeScript plugin uses, and it is the reason sampling
is safe to turn on: **errors and slow requests are always kept**, whatever the
rate. Sampling a 500 away to save storage loses the row somebody is about to go
looking for, and the rows worth dropping are the thousands of identical 200s.

The sample rate travels with the row so the dashboard can scale counts back up;
a kept-by-rule row reports 1, because it was not sampled.
"""

from __future__ import annotations

import random
from typing import NamedTuple


class Decision(NamedTuple):
    capture: bool
    #: 1 for must-keep rows, the configured rate for sampled ones.
    sample_rate: float


def clamp(rate: float) -> float:
    if rate != rate:  # NaN
        return 1.0
    return max(0.0, min(1.0, rate))


def should_capture(
    status_code: int,
    response_time_ms: float,
    sample_rate: float = 1.0,
    slow_request_ms: int = 2000,
    rand: "random.Random | None" = None,
) -> Decision:
    rate = clamp(sample_rate)
    must_keep = status_code >= 400 or response_time_ms >= slow_request_ms
    if must_keep:
        return Decision(True, 1.0)
    if rate >= 1:
        return Decision(True, 1.0)
    if rate <= 0:
        return Decision(False, rate)
    roll = (rand or random).random()
    return Decision(roll < rate, rate)
