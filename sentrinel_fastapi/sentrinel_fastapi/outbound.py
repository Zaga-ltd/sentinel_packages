# Shared with sentrinel_django: edit it there, then run scripts/sync-python-core.py.
"""Instrumenting the calls your app makes.

A slow page is often slow because of something it called. Without this the
waterfall stops at your own code and the payment gateway that took four seconds
is invisible — the request row says 4.2s and nothing says why.

Neither `requests` nor `httpx` is a dependency of this package. Each is
imported inside the code that uses it, so a project that uses neither pays
nothing and a project that uses one gets this for free.
"""

from __future__ import annotations

from typing import Any

from . import context
from .tracing import current_span_id, span
from .trace import traceparent_for


def trace_headers(headers: dict[str, str] | None = None) -> dict[str, str]:
    """Headers carrying this request's trace, for a call you are about to make.

    Uses the *current* span as the parent, so a call made inside a ``span()``
    block hangs off that block rather than off the request root.
    """
    out = dict(headers or {})
    state = context.current()
    span_id = current_span_id()
    if not state or not state.get("trace_id") or not span_id:
        return out
    out.setdefault("traceparent", traceparent_for(state["trace_id"], span_id))
    return out


class SentrinelSession:
    """A ``requests.Session`` that records every call as a span.

    ```python
    from sentrinel_fastapi import SentrinelSession

    http = SentrinelSession()
    http.get("https://api.example.com/rates")   # a span, and traceparent sent
    ```

    Wraps rather than subclasses, so it works whatever version of `requests` is
    installed and does not break if the base class changes shape. Anything not
    named here is delegated, so it behaves like the session it holds.
    """

    def __init__(self, session: Any = None) -> None:
        if session is not None:
            # Someone else's session — a configured one, a test double. Do not
            # import requests at all: this package does not depend on it, and
            # requiring it here would make that claim false for exactly the
            # callers who brought their own.
            self._session = session
            return
        import requests  # only when we have to build the default

        self._session = requests.Session()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._session, name)

    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        from urllib.parse import urlsplit

        parts = urlsplit(str(url))
        # The host and path, never the query: it carries tokens and ids, and a
        # span name is a grouping key — one per distinct query string is the
        # same cardinality problem as one endpoint per id.
        label = f"{method.upper()} {parts.netloc}{parts.path or '/'}"

        with span(label, {"http.method": method.upper(), "http.url": f"{parts.scheme}://{parts.netloc}{parts.path}"}, kind="CLIENT") as s:
            kwargs["headers"] = trace_headers(kwargs.get("headers"))
            response = self._session.request(method, url, **kwargs)
            status = getattr(response, "status_code", None)
            if status is not None:
                s["attributes"]["http.status_code"] = status
                if status >= 500:
                    s["statusCode"] = "ERROR"
            return response

    def get(self, url: str, **kw: Any) -> Any:
        return self.request("GET", url, **kw)

    def post(self, url: str, **kw: Any) -> Any:
        return self.request("POST", url, **kw)

    def put(self, url: str, **kw: Any) -> Any:
        return self.request("PUT", url, **kw)

    def patch(self, url: str, **kw: Any) -> Any:
        return self.request("PATCH", url, **kw)

    def delete(self, url: str, **kw: Any) -> Any:
        return self.request("DELETE", url, **kw)

    def head(self, url: str, **kw: Any) -> Any:
        return self.request("HEAD", url, **kw)


def _client_span_label(method: str, url: Any) -> tuple[str, dict[str, Any]]:
    from urllib.parse import urlsplit

    parts = urlsplit(str(url))
    # Host and path, never the query: it carries tokens and ids, and a span
    # name is a grouping key.
    label = f"{method.upper()} {parts.netloc}{parts.path or '/'}"
    return label, {"http.method": method.upper(), "http.url": f"{parts.scheme}://{parts.netloc}{parts.path}"}


def httpx_transport(transport: Any = None) -> Any:
    """An ``httpx`` transport that records each call as a span and sends ``traceparent``.

    ```python
    import httpx
    from sentrinel_fastapi import httpx_transport

    client = httpx.Client(transport=httpx_transport())
    ```

    Pass your own transport to keep its settings (retries, proxies, HTTP/2); it
    is wrapped, not replaced.
    """
    import httpx

    inner = transport or httpx.HTTPTransport()

    class _Traced(httpx.BaseTransport):
        def handle_request(self, request: Any) -> Any:
            label, attrs = _client_span_label(request.method, request.url)
            with span(label, attrs, kind="CLIENT") as s:
                for key, value in trace_headers().items():
                    request.headers.setdefault(key, value)
                response = inner.handle_request(request)
                _mark(s, response.status_code)
                return response

        def close(self) -> None:
            inner.close()

    return _Traced()


def async_httpx_transport(transport: Any = None) -> Any:
    """The ``httpx.AsyncClient`` form of :func:`httpx_transport`.

    ```python
    client = httpx.AsyncClient(transport=async_httpx_transport())
    ```

    The span covers the call up to the response headers. The body is read by
    your code afterwards, on its own time, and a span held open for it would
    blame the remote service for however long you took to read it.
    """
    import httpx

    inner = transport or httpx.AsyncHTTPTransport()

    class _Traced(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: Any) -> Any:
            label, attrs = _client_span_label(request.method, request.url)
            with span(label, attrs, kind="CLIENT") as s:
                for key, value in trace_headers().items():
                    request.headers.setdefault(key, value)
                response = await inner.handle_async_request(request)
                _mark(s, response.status_code)
                return response

        async def aclose(self) -> None:
            await inner.aclose()

    return _Traced()


def _mark(s: dict[str, Any], status: int | None) -> None:
    if status is None:
        return
    s["attributes"]["http.status_code"] = status
    if status >= 500:
        s["statusCode"] = "ERROR"

