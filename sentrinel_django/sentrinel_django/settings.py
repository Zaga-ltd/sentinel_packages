"""Reading the ``SENTRINEL`` block from Django settings.

The one piece of configuration that knows about Django; everything it produces
is the framework-neutral ``Config`` the rest of the package shares with the
FastAPI SDK.
"""

from __future__ import annotations

from .config import Config, load


def from_django_settings() -> Config:
    try:
        from django.conf import settings as django_settings

        raw = getattr(django_settings, "SENTRINEL", None)
    except Exception:  # Django not configured yet — the env still works.
        raw = None
    return load(raw)
