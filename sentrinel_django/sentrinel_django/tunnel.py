"""The endpoint the browser SDK posts to.

Everything in a JavaScript bundle is public, so the browser SDK holds **no API
key**. It posts batches to your own server, and your server forwards them with
the key. This is that endpoint, in one URL line.

It also pins `appName` and `env` server-side, ignoring whatever the batch
claims. Without that, anyone who found the URL could write telemetry into a
different app in your account.
"""

from __future__ import annotations

import json
from typing import Any

from .collector import get_collector

#: Batch keys the browser SDK sends, and the ingest path each belongs to.
_ROUTES: tuple[tuple[str, str], ...] = (
    ("errors", "/api/ingest/errors"),
    ("requests", "/api/ingest/requests"),
    ("logs", "/api/ingest/logs"),
    ("sessions", "/api/ingest/sessions"),
    ("events", "/api/ingest/events"),
    ("replay", "/api/ingest/replay"),
)

#: A browser batch is small. Anything past this is not a browser.
MAX_BODY_BYTES = 2_000_000


def sentrinel_tunnel(request: Any) -> Any:
    """Forward a browser batch to Sentrinel.

    ```python
    # urls.py
    from sentrinel_django import sentrinel_tunnel

    urlpatterns = [
        path("api/_sentrinel", sentrinel_tunnel),
        ...
    ]
    ```

    Then point the browser SDK at that path. It is `csrf_exempt` because the
    caller is a script posting JSON with no session — a CSRF token would have
    to be embedded in the page for a request that carries no authority anyway.
    """
    from django.http import HttpResponse, JsonResponse
    from django.views.decorators.csrf import csrf_exempt  # noqa: F401  (documented above)

    if request.method != "POST":
        return HttpResponse(status=405)

    collector = get_collector()
    cfg = collector.config
    if not cfg.configured:
        # Accept and drop: a misconfigured server should not make the page
        # retry forever, and the browser cannot fix this.
        return JsonResponse({"ok": False, "reason": "not configured"}, status=202)

    try:
        raw = request.body
    except Exception:
        return HttpResponse(status=400)
    if len(raw) > MAX_BODY_BYTES:
        return JsonResponse({"error": "batch too large"}, status=413)

    try:
        batch = json.loads(raw or b"{}")
    except ValueError:
        return HttpResponse(status=400)
    if not isinstance(batch, dict):
        return HttpResponse(status=400)

    forwarded = 0
    for key, path in _ROUTES:
        rows = batch.get(key)
        if not rows:
            continue
        # appName and env come from settings, never from the batch.
        collector._post(path, {"appName": cfg.app_name, "env": cfg.env, key: rows})
        forwarded += len(rows) if isinstance(rows, list) else 1

    return JsonResponse({"ok": True, "forwarded": forwarded})


# Applied here rather than as a decorator above so the function keeps a plain
# signature for tests, which call it directly with a RequestFactory request.
try:  # pragma: no cover - Django is always present where this is used
    from django.views.decorators.csrf import csrf_exempt as _csrf_exempt

    sentrinel_tunnel = _csrf_exempt(sentrinel_tunnel)  # type: ignore[assignment]
except Exception:  # pragma: no cover
    pass
