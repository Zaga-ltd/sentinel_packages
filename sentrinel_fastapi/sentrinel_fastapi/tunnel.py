"""The endpoint the browser SDK posts to, as a Starlette route.

The forwarding itself — which paths, and pinning ``appName``, ``env`` and
``module`` so a page cannot write anywhere else — is ``tunnel_core``, shared
with the Django SDK. This is the async request and response around it.

Forwarding is a blocking HTTP call per ingest path, so it runs in a worker
thread: on the event loop it would stall every other request this process is
serving for as long as Sentrinel took to answer.
"""

from __future__ import annotations

from typing import Any

from .collector import get_collector
from .tunnel_core import MAX_BODY_BYTES, forward

__all__ = ["sentrinel_tunnel"]


async def sentrinel_tunnel(request: Any) -> Any:
    """Forward a browser batch to Sentrinel.

    ```python
    from sentrinel_fastapi import sentrinel_tunnel

    app.add_route("/api/_sentrinel", sentrinel_tunnel, methods=["POST"])
    ```

    Then point the browser SDK's ``endpoint`` at that path.
    """
    from starlette.concurrency import run_in_threadpool
    from starlette.responses import JSONResponse, Response

    # The browser's telemetry in transit, once per flush — not a request of
    # this app. Recording it filled the endpoint list with a route nobody wrote.
    request.scope["sentrinel.skip"] = True

    if request.method != "POST":
        return Response(status_code=405)

    # Read with a ceiling rather than all at once: an open endpoint that will
    # buffer anything is a memory-exhaustion target.
    chunks: list[bytes] = []
    total = 0
    try:
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_BODY_BYTES:
                return JSONResponse({"error": "batch too large"}, status_code=413)
            chunks.append(chunk)
    except Exception:
        return Response(status_code=400)

    status, body = await run_in_threadpool(forward, get_collector(), b"".join(chunks))
    return JSONResponse(body, status_code=status)
