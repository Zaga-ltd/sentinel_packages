"""Configuration, read once from Django settings.

Everything lives under a single ``SENTRINEL`` dict so a project's settings file
gains one block rather than fifteen top-level names::

    SENTRINEL = {
        "SERVER_URL": "https://api.sentrinel.dev",
        "APP_NAME": "orders",
        "ENV": "prod",
        "API_KEY": os.environ["SENTRINEL_API_KEY"],
    }

Defaults are chosen so that a deployment which sets only those four keys
collects the useful things and none of the dangerous ones: bodies are off,
sensitive headers are masked, and errors are always kept.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Pattern, Sequence

#: Headers whose values are never sent, whatever the project configures.
#
# A deny-list is the wrong shape for secrets in general, but these four are the
# ones that carry credentials in practice, and a project that forgets to
# configure masking should still not ship its Authorization headers.
DEFAULT_MASK_HEADERS: tuple[str, ...] = (
    r"^authorization$",
    r"^cookie$",
    r"^set-cookie$",
    r"^x-api-key$",
    r"^x-csrftoken$",
    r"^proxy-authorization$",
)

#: Body and query fields masked by name, case-insensitively.
DEFAULT_MASK_FIELDS: tuple[str, ...] = (
    r"password",
    r"passwd",
    r"secret",
    r"token",
    r"api_?key",
    r"authorization",
    r"credit_?card",
    r"card_?number",
    r"cvv",
    r"ssn",
)

MASK_VALUE = "***"


def _compile(patterns: Iterable[Any]) -> list[Pattern[str]]:
    """Accept strings or pre-compiled patterns, as a Django setting may hold either."""
    out: list[Pattern[str]] = []
    for p in patterns or ():
        if isinstance(p, str):
            out.append(re.compile(p, re.IGNORECASE))
        elif hasattr(p, "search"):
            out.append(p)  # already compiled
    return out


@dataclass
class Config:
    server_url: str = ""
    app_name: str = ""
    env: str = "dev"
    api_key: str = ""
    version: str | None = None

    enabled: bool = True
    debug: bool = False

    flush_interval: float = 10.0
    max_buffer: int = 10_000
    timeout: float = 5.0

    # ── What to capture ────────────────────────────────────────────────────
    capture_requests: bool = True
    capture_errors: bool = True
    capture_logs: bool = True
    sample_rate: float = 1.0
    slow_request_ms: int = 2000

    log_request_headers: bool = True
    log_request_body: bool = False
    log_response_body: bool = False
    max_body_bytes: int = 10_000

    exclude_paths: list[Pattern[str]] = field(default_factory=list)
    mask_headers: list[Pattern[str]] = field(default_factory=list)
    mask_fields: list[Pattern[str]] = field(default_factory=list)

    #: Called with the request; returns the identifier, or None for anonymous.
    consumer_identifier: Callable[[Any], str | None] | None = None

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.server_url and self.app_name)


def _resolve_callable(value: Any) -> Callable[[Any], str | None] | None:
    """Accept a callable or a dotted path, because settings files hold strings."""
    if value is None or callable(value):
        return value
    if isinstance(value, str):
        module_path, _, attr = value.rpartition(".")
        if not module_path:
            return None
        from importlib import import_module

        try:
            return getattr(import_module(module_path), attr)
        except (ImportError, AttributeError):
            return None
    return None


def _as_sequence(value: Any, fallback: Sequence[Any]) -> Sequence[Any]:
    return value if isinstance(value, (list, tuple)) else fallback


def load(settings_dict: dict[str, Any] | None = None) -> Config:
    """Build a Config from a settings dict, falling back to the environment.

    The environment fallback exists because the twelve-factor way to hand a
    container its key is an environment variable, and requiring people to write
    ``os.environ[...]`` into settings to bridge that is friction with no
    benefit.
    """
    raw = dict(settings_dict or {})

    def pick(key: str, env_key: str, default: Any = None) -> Any:
        if key in raw and raw[key] is not None:
            return raw[key]
        return os.environ.get(env_key, default)

    cfg = Config(
        server_url=str(pick("SERVER_URL", "SENTRINEL_SERVER_URL", "") or "").rstrip("/"),
        app_name=str(pick("APP_NAME", "SENTRINEL_APP_NAME", "") or ""),
        env=str(pick("ENV", "SENTRINEL_ENV", "dev") or "dev"),
        api_key=str(pick("API_KEY", "SENTRINEL_API_KEY", "") or ""),
        version=pick("VERSION", "SENTRINEL_VERSION", None),
    )

    enabled = pick("ENABLED", "SENTRINEL_ENABLED", True)
    cfg.enabled = enabled if isinstance(enabled, bool) else str(enabled).lower() not in ("0", "false", "no")
    cfg.debug = bool(raw.get("DEBUG", False))

    cfg.flush_interval = float(raw.get("FLUSH_INTERVAL", cfg.flush_interval))
    cfg.max_buffer = int(raw.get("MAX_BUFFER", cfg.max_buffer))
    cfg.timeout = float(raw.get("TIMEOUT", cfg.timeout))

    cfg.capture_requests = bool(raw.get("CAPTURE_REQUESTS", True))
    cfg.capture_errors = bool(raw.get("CAPTURE_ERRORS", True))
    cfg.capture_logs = bool(raw.get("CAPTURE_LOGS", True))
    cfg.sample_rate = float(raw.get("SAMPLE_RATE", 1.0))
    cfg.slow_request_ms = int(raw.get("SLOW_REQUEST_MS", 2000))

    cfg.log_request_headers = bool(raw.get("LOG_REQUEST_HEADERS", True))
    cfg.log_request_body = bool(raw.get("LOG_REQUEST_BODY", False))
    cfg.log_response_body = bool(raw.get("LOG_RESPONSE_BODY", False))
    cfg.max_body_bytes = int(raw.get("MAX_BODY_BYTES", 10_000))

    cfg.exclude_paths = _compile(_as_sequence(raw.get("EXCLUDE_PATHS"), ()))
    # Project patterns extend the defaults rather than replacing them: someone
    # adding "x-internal-token" to the list did not mean "and start sending
    # Authorization".
    cfg.mask_headers = _compile(DEFAULT_MASK_HEADERS) + _compile(_as_sequence(raw.get("MASK_HEADERS"), ()))
    cfg.mask_fields = _compile(DEFAULT_MASK_FIELDS) + _compile(_as_sequence(raw.get("MASK_FIELDS"), ()))

    cfg.consumer_identifier = _resolve_callable(raw.get("CONSUMER_IDENTIFIER"))
    return cfg


def from_django_settings() -> Config:
    try:
        from django.conf import settings as django_settings

        raw = getattr(django_settings, "SENTRINEL", None)
    except Exception:  # Django not configured yet — the env still works.
        raw = None
    return load(raw)
