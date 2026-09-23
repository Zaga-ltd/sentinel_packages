"""The endpoint the browser SDK posts to, as a Django view.

The forwarding itself — which paths, and pinning ``appName``, ``env`` and
``module`` so a page cannot write anywhere else — is ``tunnel_core``, shared
with the FastAPI SDK. This is only the Django request and response around it.
"""

from __future__ import annotations

from typing import Any

from .collector import get_collector
from .tunnel_core import MAX_BODY_BYTES, ROUTES as _ROUTES, forward

__all__ = ["sentrinel_tunnel", "forward", "MAX_BODY_BYTES", "_ROUTES"]


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

    # Not recorded as a request of this app — see the middleware.
    request._sentrinel_skip = True
    if request.method != "POST":
        return HttpResponse(status=405)

    try:
        raw = request.body
    except Exception:
        return HttpResponse(status=400)

    status, body = forward(get_collector(), raw)
    return JsonResponse(body, status=status)


# Applied here rather than as a decorator above so the function keeps a plain
# signature for tests, which call it directly with a RequestFactory request.
try:  # pragma: no cover - Django is always present where this is used
    from django.views.decorators.csrf import csrf_exempt as _csrf_exempt

    sentrinel_tunnel = _csrf_exempt(sentrinel_tunnel)  # type: ignore[assignment]
except Exception:  # pragma: no cover
    pass
