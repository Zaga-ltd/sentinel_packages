# Shared with sentrinel_django: edit it there, then run scripts/sync-python-core.py.
"""Forwarding a browser batch: the part every framework's tunnel shares.

Everything in a JavaScript bundle is public, so the browser SDK holds **no API
key**. It posts batches to your own server, and your server forwards them with
the key. Each framework package wraps this in its own endpoint — a Django view,
a Starlette route — and this is what they wrap.

It pins `appName`, `env` and `module` server-side, ignoring whatever the batch
claims. Without that, anyone who found the URL could write telemetry into a
different app in your account, or label it as a different part of this one.
The part is `TUNNEL_MODULE` ("web" unless set), not this server's `MODULE`: the
page and the server are two parts of one project, and a batch through here is
always the page's.
"""

from __future__ import annotations

import json
from typing import Any

#: Batch keys the browser SDK sends, and the ingest path each belongs to.
ROUTES: tuple[tuple[str, str], ...] = (
    ("errors", "/api/ingest/errors"),
    ("requests", "/api/ingest/requests"),
    ("logs", "/api/ingest/logs"),
    ("sessions", "/api/ingest/sessions"),
    ("events", "/api/ingest/events"),
    ("replay", "/api/ingest/replay"),
)

#: A browser batch is small. Anything past this is not a browser.
MAX_BODY_BYTES = 2_000_000


def forward(collector: Any, raw: bytes | None) -> tuple[int, dict[str, Any]]:
    """Forward one batch. Returns the status and JSON body to answer the page with.

    Blocking — each ingest path is one request to Sentrinel. An async framework
    runs this in a worker thread rather than on its event loop.
    """
    cfg = collector.config
    if not cfg.configured:
        # Accept and drop: a misconfigured server should not make the page
        # retry forever, and the browser cannot fix this.
        return 202, {"ok": False, "reason": "not configured"}

    raw = raw or b""
    if len(raw) > MAX_BODY_BYTES:
        return 413, {"error": "batch too large"}
    try:
        batch = json.loads(raw or b"{}")
    except ValueError:
        return 400, {"error": "invalid JSON"}
    if not isinstance(batch, dict):
        return 400, {"error": "a batch is a JSON object"}

    forwarded = 0
    for key, path in ROUTES:
        rows = batch.get(key)
        if not rows:
            continue
        # appName, env and module come from settings, never from the batch.
        head = {"appName": cfg.app_name, "env": cfg.env}
        if cfg.tunnel_module:
            head["module"] = cfg.tunnel_module
        collector._post(path, {**head, key: rows})
        forwarded += len(rows) if isinstance(rows, list) else 1
    return 200, {"ok": True, "forwarded": forwarded}
