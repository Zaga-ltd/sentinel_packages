"""The shared core must be the Django SDK's, byte for byte.

The collector, configuration, masking, sampling, tracing, metrics and the log
handler are one code base kept in two packages, so each installs on its own
with no dependencies. Two copies of a rule is how one of them quietly stops
matching the other — a masking default fixed in one SDK and not the other is a
secret shipped by the second.

Runs wherever both packages sit side by side: the monorepo, and the public
repo. Anywhere else there is nothing to compare against.
"""

from __future__ import annotations

from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent / "sentrinel_fastapi"
DJANGO = Path(__file__).resolve().parent.parent.parent / "sentrinel_django" / "sentrinel_django"

SHARED = (
    "collector",
    "config",
    "context",
    "errors",
    "logs",
    "masking",
    "metrics",
    "outbound",
    "route_template",
    "sampling",
    "trace",
    "tracing",
    "tunnel_core",
)

MARKER = "# Shared with sentrinel_django: edit it there, then run scripts/sync-python-core.py.\n"


def render(text: str) -> str:
    return MARKER + text.replace("sentrinel_django", "sentrinel_fastapi").replace(
        "sentrinel-django", "sentrinel-fastapi"
    )


@pytest.mark.skipif(not DJANGO.exists(), reason="the Django SDK is not beside this package")
@pytest.mark.parametrize("name", SHARED)
def test_the_shared_module_matches_the_django_sdk(name):
    want = render((DJANGO / f"{name}.py").read_text())
    have = (HERE / f"{name}.py").read_text()
    assert have == want, (
        f"{name}.py differs from sentrinel_django's. Edit it there, then run "
        "python3 scripts/sync-python-core.py"
    )


def test_every_module_is_either_shared_or_this_frameworks_own():
    """A new module has to be put on one side of the line on purpose."""
    own = {"__init__", "middleware", "routes", "tunnel"}
    present = {p.stem for p in HERE.glob("*.py")}
    assert present == set(SHARED) | own, sorted(present ^ (set(SHARED) | own))
