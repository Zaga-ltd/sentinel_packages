"""Shared fixtures: a real FastAPI app, the real middleware, the network stubbed."""

from __future__ import annotations

import os

import pytest

from sentrinel_fastapi import collector as collector_module
from sentrinel_fastapi import metrics
from sentrinel_fastapi.config import load
from sentrinel_fastapi.middleware import SentrinelMiddleware, settings_from_options

#: The environment is a fallback for every setting; a developer's own
#: SENTRINEL_* variables must not change what the suite is testing.
for _name in list(os.environ):
    if _name.startswith("SENTRINEL_"):
        del os.environ[_name]

BASE = {"server_url": "http://api.test", "app_name": "orders", "env": "prod"}


class Captured:
    """Stands in for the network, and remembers what would have been sent."""

    def __init__(self) -> None:
        self.posts: list[tuple[str, dict]] = []

    def install(self, collector):
        collector._post = lambda path, payload, attempt=0: self.posts.append((path, payload))
        # The flusher would otherwise start a thread per test.
        collector._ensure_started = lambda: None
        return collector

    def payload(self, path):
        for p, body in self.posts:
            if p == path:
                return body
        return None

    def payloads(self, path):
        return [body for p, body in self.posts if p == path]

    def rows(self, path, key):
        return [row for body in self.payloads(path) for row in body.get(key) or []]


@pytest.fixture
def sent():
    return Captured()


@pytest.fixture
def build(sent):
    """Instrument an app with whatever options, returning a client and the collector."""

    def _build(app, raise_server_exceptions=True, **overrides):
        from fastapi.testclient import TestClient

        options = {**BASE, **overrides}
        collector_module.reset_collector()
        collector = sent.install(collector_module.Collector(load(settings_from_options(options))))
        collector_module.set_collector(collector)
        app.add_middleware(SentrinelMiddleware, **options)
        return TestClient(app, raise_server_exceptions=raise_server_exceptions), collector

    return _build


@pytest.fixture(autouse=True)
def _clean():
    metrics._registry = metrics.MetricRegistry()
    yield
    collector_module.reset_collector()
