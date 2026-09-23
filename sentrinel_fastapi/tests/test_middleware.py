"""Real requests through a real FastAPI app and the real middleware.

What these pin down is the contract with the API — field names and shapes, the
same as the Django and Node SDKs send — and the promise that telemetry never
changes what the application returns.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

import pytest
from fastapi import APIRouter, BackgroundTasks, FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

from sentrinel_fastapi import collector as collector_module
from sentrinel_fastapi.collector import get_collector
from sentrinel_fastapi.config import load
from sentrinel_fastapi.middleware import SentrinelMiddleware

MOBILE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


def make_app() -> FastAPI:
    app = FastAPI()

    @app.get("/ok")
    async def ok():
        return {"ok": True}

    @app.get("/sync")
    def sync_ok():
        return {"ok": True}

    @app.get("/orders/{order_id}")
    async def order(order_id: int):
        if order_id == 404:
            raise HTTPException(status_code=404, detail="order not found")
        return {"id": order_id}

    @app.get("/search")
    async def search(limit: int):
        return {"limit": limit}

    @app.post("/checkout")
    async def checkout(request: Request):
        body = await request.json()
        return {"received": sorted(body)}

    @app.get("/boom")
    async def boom():
        raise ValueError("kaboom")

    @app.get("/files/{file_path:path}")
    async def files(file_path: str):
        return {"path": file_path}

    return app


class TestRequestCapture:
    def test_a_request_produces_a_row_the_api_accepts(self, build, sent):
        client, collector = build(make_app())
        assert client.get("/orders/42?page=2").status_code == 200
        collector.flush()

        body = sent.payload("/api/ingest/requests")
        assert body["appName"] == "orders" and body["env"] == "prod"
        row = body["requests"][0]
        assert row["method"] == "GET"
        # The URL that was asked for, and the route it belongs to — the route
        # written the way every other SDK writes it.
        assert row["path"] == "/orders/42"
        assert row["route"] == "/orders/:order_id"
        assert row["statusCode"] == 200
        assert row["responseTime"] >= 0
        assert row["sampleRate"] == 1
        assert row["queryParams"] == {"page": "2"}
        assert row["host"] == "testserver"
        assert row["clientIp"] == "testclient"
        assert len(row["id"]) == 36 and row["timestamp"].endswith("Z")

    def test_the_response_is_unchanged(self, build):
        plain = make_app()
        from fastapi.testclient import TestClient

        before = TestClient(plain).post("/checkout", json={"b": 1, "a": 2})
        client, _ = build(make_app())
        after = client.post("/checkout", json={"b": 1, "a": 2})
        assert (after.status_code, after.json(), after.headers["content-type"]) == (
            before.status_code,
            before.json(),
            before.headers["content-type"],
        )

    def test_sync_and_async_endpoints_are_both_recorded(self, build, sent):
        client, collector = build(make_app())
        client.get("/ok")
        client.get("/sync")
        collector.flush()
        assert sorted(r["route"] for r in sent.rows("/api/ingest/requests", "requests")) == ["/ok", "/sync"]

    def test_metrics_roll_up_instead_of_one_row_per_request(self, build, sent):
        client, collector = build(make_app())
        for i in range(3):
            client.get(f"/orders/{i + 1}")
        collector.flush()
        endpoints = sent.rows("/api/ingest/metrics", "endpoints")
        assert len(endpoints) == 1
        assert endpoints[0]["path"] == "/orders/:order_id"
        assert endpoints[0]["requestCount"] == 3

    def test_excluded_paths_are_not_recorded(self, build, sent):
        client, collector = build(make_app(), exclude_paths=[r"^/ok$"])
        client.get("/ok")
        collector.flush()
        assert sent.payload("/api/ingest/requests") is None
        assert sent.payload("/api/ingest/metrics") is None

    def test_credentials_are_masked_before_buffering(self, build, sent):
        client, collector = build(make_app())
        client.get("/ok", headers={"Authorization": "Bearer s3cret", "Cookie": "sid=abc", "X-Trace-Me": "yes"})
        collector.flush()
        headers = sent.rows("/api/ingest/requests", "requests")[0]["requestHeaders"]
        assert headers["authorization"] == "***" and headers["cookie"] == "***"
        assert headers["x-trace-me"] == "yes"

    def test_query_secrets_are_masked(self, build, sent):
        client, collector = build(make_app())
        client.get("/ok?token=abc&page=1")
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["queryParams"] == {"token": "***", "page": "1"}

    def test_bodies_are_off_unless_asked_for(self, build, sent):
        client, collector = build(make_app())
        client.post("/checkout", json={"sku": "A-1"})
        collector.flush()
        row = sent.rows("/api/ingest/requests", "requests")[0]
        assert "requestBody" not in row and "responseBody" not in row

    def test_a_captured_body_is_masked_and_the_app_still_reads_it(self, build, sent):
        client, collector = build(make_app(), log_request_body=True, log_response_body=True)
        res = client.post("/checkout", json={"sku": "A-1", "password": "hunter2"})
        # Watching the body go past must not starve the endpoint of it.
        assert res.json() == {"received": ["password", "sku"]}
        collector.flush()
        row = sent.rows("/api/ingest/requests", "requests")[0]
        # Bodies travel as masked JSON text, as the Django and Node SDKs send them.
        request_body = json.loads(row["requestBody"])
        assert request_body["password"] == "***" and request_body["sku"] == "A-1"
        assert json.loads(row["responseBody"]) == {"received": ["password", "sku"]}
        assert row["requestSize"] > 0 and row["responseSize"] > 0

    def test_the_client_ip_is_the_caller_not_the_proxy(self, build, sent):
        client, collector = build(make_app())
        client.get("/ok", headers={"X-Forwarded-For": "203.0.113.9, 10.0.0.2"})
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["clientIp"] == "203.0.113.9"

    def test_a_streaming_response_streams_through(self, build, sent):
        app = FastAPI()

        @app.get("/stream")
        async def stream():
            async def chunks():
                for i in range(5):
                    yield f"chunk {i}\n".encode()

            return StreamingResponse(chunks(), media_type="text/plain")

        client, collector = build(app, log_response_body=True)
        res = client.get("/stream")
        assert res.text == "".join(f"chunk {i}\n" for i in range(5))
        collector.flush()
        row = sent.rows("/api/ingest/requests", "requests")[0]
        assert row["responseSize"] == len(res.content)

    def test_background_tasks_do_not_count_against_the_response_time(self, build, sent):
        """Starlette runs background tasks after the response, inside the same
        call. Timing the whole call blamed the endpoint for work nobody waited on."""
        app = FastAPI()

        def slow_job():
            time.sleep(0.5)

        @app.post("/signup")
        async def signup(tasks: BackgroundTasks):
            tasks.add_task(slow_job)
            return {"queued": True}

        client, collector = build(app)
        client.post("/signup")
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["responseTime"] < 400

    def test_websockets_and_lifespan_pass_straight_through(self, build, sent):
        app = FastAPI()

        @app.websocket("/ws")
        async def ws(socket: WebSocket):
            await socket.accept()
            await socket.send_text("hi " + await socket.receive_text())
            await socket.close()

        client, collector = build(app)
        with client:  # runs the lifespan
            with client.websocket_connect("/ws") as socket:
                socket.send_text("there")
                assert socket.receive_text() == "hi there"
        collector.flush()
        assert sent.payload("/api/ingest/requests") is None


class TestRoutes:
    def test_a_router_prefix_is_part_of_the_route(self, build, sent):
        app = FastAPI()
        router = APIRouter(prefix="/api/v1/customers")

        @router.get("/{customer_id}/sites")
        async def sites(customer_id: str):
            return []

        app.include_router(router)
        client, collector = build(app)
        client.get("/api/v1/customers/cust_9/sites")
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["route"] == "/api/v1/customers/:customer_id/sites"

    def test_a_mounted_app_keeps_its_mount_prefix(self, build, sent):
        """Without the prefix, /v2/items/{id} on a mounted sub-application is
        reported as /items/{id} and merges with the top-level route of that name."""
        app = FastAPI()
        v2 = FastAPI()

        @v2.get("/items/{item_id}")
        async def item(item_id: int):
            return {"id": item_id}

        @app.get("/items/{item_id}")
        async def top_item(item_id: int):
            return {"id": item_id}

        app.mount("/v2", v2)
        client, collector = build(app)
        client.get("/v2/items/5")
        client.get("/items/5")
        collector.flush()
        routes = sorted(r["route"] for r in sent.rows("/api/ingest/requests", "requests"))
        assert routes == ["/items/:item_id", "/v2/items/:item_id"]

    def test_a_path_converter_is_one_parameter(self, build, sent):
        client, collector = build(make_app())
        client.get("/files/reports/2026/q3.pdf")
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["route"] == "/files/:file_path"

    def test_an_unmatched_path_still_collapses_its_ids(self, build, sent):
        client, collector = build(make_app())
        assert client.get("/nothing/12345").status_code == 404
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["route"] == "/nothing/:id"

    def test_a_plain_starlette_app_is_routed_too(self, build, sent):
        from starlette.applications import Starlette
        from starlette.routing import Route

        async def user(request):
            return PlainTextResponse(request.path_params["user_id"])

        app = Starlette(routes=[Route("/users/{user_id}", user)])
        client, collector = build(app)
        assert client.get("/users/7").text == "7"
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["route"] == "/users/:user_id"


class TestErrors:
    def test_an_unhandled_exception_is_captured_and_still_raised(self, build, sent):
        client, collector = build(make_app())
        with pytest.raises(ValueError):
            client.get("/boom")
        collector.flush()

        err = sent.rows("/api/ingest/errors", "errors")[0]
        assert err["errorType"] == "ValueError" and err["errorMessage"] == "kaboom"
        assert "Traceback" in err["stackTrace"]
        assert err["statusCode"] == 500
        # The route, so the error joins the endpoint the requests registered.
        assert err["path"] == "/boom"
        assert sent.rows("/api/ingest/requests", "requests")[0]["statusCode"] == 500

    def test_the_client_still_gets_a_500(self, build, sent):
        client, collector = build(make_app(), raise_server_exceptions=False)
        assert client.get("/boom").status_code == 500
        collector.flush()
        assert len(sent.rows("/api/ingest/errors", "errors")) == 1

    def test_an_http_exception_is_an_error_with_its_detail(self, build, sent):
        """FastAPI turns an HTTPException into a response before the middleware
        sees anything. The Node plugin records a 404 like this; so does this."""
        client, collector = build(make_app())
        assert client.get("/orders/404").status_code == 404
        collector.flush()
        err = sent.rows("/api/ingest/errors", "errors")[0]
        assert err["statusCode"] == 404
        assert err["errorMessage"] == "order not found"
        assert err["errorType"] == "HTTPException"
        assert err["path"] == "/orders/:order_id"

    def test_a_validation_failure_says_which_field(self, build, sent):
        client, collector = build(make_app())
        assert client.get("/search?limit=lots").status_code == 422
        collector.flush()
        err = sent.rows("/api/ingest/errors", "errors")[0]
        assert err["statusCode"] == 422
        assert err["errorType"] == "RequestValidationError"
        assert err["errorMessage"].startswith("query.limit:")

    def test_a_handled_exception_is_one_error_not_two(self, build, sent):
        from sentrinel_fastapi import capture_exception

        class PaymentError(Exception):
            pass

        app = FastAPI()

        @app.exception_handler(PaymentError)
        async def payment_failed(request: Request, exc: PaymentError):
            capture_exception(exc, request=request, attributes={"gateway": "stripe"})
            return JSONResponse({"detail": "payment failed"}, status_code=402)

        @app.post("/pay/{order_id}")
        async def pay(order_id: int):
            raise PaymentError("card declined")

        client, collector = build(app)
        assert client.post("/pay/3").status_code == 402
        collector.flush()
        errors = sent.rows("/api/ingest/errors", "errors")
        assert len(errors) == 1
        assert errors[0]["errorType"] == "PaymentError"
        assert errors[0]["path"] == "/pay/:order_id"
        assert errors[0]["attributes"]["gateway"] == "stripe"
        assert "card declined" in errors[0]["stackTrace"]
        # The status the caller got, not a guess made before the handler answered.
        assert errors[0]["statusCode"] == 402
        assert errors[0]["statusMessage"] == "Payment Required"

    def test_a_handled_error_the_caller_never_saw_stays_a_500(self, build, sent):
        from sentrinel_fastapi import capture_exception

        app = FastAPI()

        @app.get("/rates")
        async def rates(request: Request):
            try:
                raise TimeoutError("rates API slow")
            except TimeoutError as exc:
                capture_exception(exc, request=request)
                return {"rates": "cached"}

        client, collector = build(app, consumer_identifier="x-tenant")
        assert client.get("/rates", headers={"x-tenant": "acme"}).status_code == 200
        collector.flush()
        [err] = sent.rows("/api/ingest/errors", "errors")
        assert (err["statusCode"], err["statusMessage"]) == (500, "Handled")
        # Identity decided by the time the response completes reaches it too.
        assert err["consumerIdentifier"] == "acme"

    def test_a_handled_error_outside_a_request_is_sent_at_once(self, build, sent):
        from sentrinel_fastapi import capture_exception

        _, collector = build(make_app())
        capture_exception(RuntimeError("nightly job failed"))
        collector.flush()
        [err] = sent.rows("/api/ingest/errors", "errors")
        assert (err["statusCode"], err["errorType"]) == (500, "RuntimeError")

    def test_an_error_is_never_sampled_away(self, build, sent):
        client, collector = build(make_app(), sample_rate=0.0, raise_server_exceptions=False)
        client.get("/boom")
        collector.flush()
        rows = sent.rows("/api/ingest/requests", "requests")
        assert len(rows) == 1 and rows[0]["sampleRate"] == 1

    def test_ordinary_traffic_is_sampled_away_at_rate_zero(self, build, sent):
        client, collector = build(make_app(), sample_rate=0.0)
        client.get("/ok")
        collector.flush()
        assert sent.payload("/api/ingest/requests") is None
        # …but it still counted, because metrics are exact regardless of sampling.
        assert sent.rows("/api/ingest/metrics", "endpoints")[0]["requestCount"] == 1

    def test_errors_can_be_turned_off(self, build, sent):
        client, collector = build(make_app(), capture_errors=False)
        client.get("/orders/404")
        collector.flush()
        assert sent.payload("/api/ingest/errors") is None


class TestIdentity:
    def test_a_header_name_names_the_consumer(self, build, sent):
        client, collector = build(make_app(), consumer_identifier="x-tenant")
        client.get("/ok", headers={"X-Tenant": "acme"})
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["consumerIdentifier"] == "acme"
        assert sent.rows("/api/ingest/metrics", "consumers")[0]["identifier"] == "acme"

    def test_a_function_is_handed_the_request(self, build, sent):
        client, collector = build(make_app(), consumer_identifier=lambda request: request.query_params.get("user"))
        client.get("/ok?user=u_42")
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["consumerIdentifier"] == "u_42"

    def test_a_broken_resolver_does_not_break_the_request(self, build, sent):
        def broken(request):
            raise RuntimeError("session store down")

        client, collector = build(make_app(), consumer_identifier=broken)
        assert client.get("/ok").status_code == 200
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["consumerIdentifier"] is None

    def test_a_starlette_authenticated_user_is_the_consumer(self, build, sent):
        from starlette.authentication import AuthCredentials, AuthenticationBackend, SimpleUser
        from starlette.middleware.authentication import AuthenticationMiddleware

        class HeaderAuth(AuthenticationBackend):
            async def authenticate(self, conn):
                name = conn.headers.get("x-user")
                return (AuthCredentials(["authenticated"]), SimpleUser(name)) if name else None

        app = make_app()
        app.add_middleware(AuthenticationMiddleware, backend=HeaderAuth())
        # Added after, so it runs first — and still reads the user the inner
        # middleware established, at the end of the request.
        client, collector = build(app)
        client.get("/ok", headers={"X-User": "ada"})
        client.get("/ok")
        collector.flush()
        consumers = [r["consumerIdentifier"] for r in sent.rows("/api/ingest/requests", "requests")]
        assert consumers == ["ada", None]

    def test_identity_and_context_set_in_the_endpoint_land_on_the_row(self, build, sent):
        from sentrinel_fastapi import add_context, set_consumer

        app = FastAPI()

        @app.get("/me")
        async def me():
            set_consumer("user_7")
            add_context(tier="enterprise", flag_new_checkout=True)
            return {}

        client, collector = build(app)
        client.get("/me")
        collector.flush()
        row = sent.rows("/api/ingest/requests", "requests")[0]
        assert row["consumerIdentifier"] == "user_7"
        assert row["attributes"] == {"tier": "enterprise", "flag_new_checkout": True}

    def test_a_misspelt_option_is_an_error_not_silence(self):
        with pytest.raises(TypeError, match="did you mean 'api_key'"):
            SentrinelMiddleware(make_app(), server_url="http://x", app_name="a", api_kye="snt_live_x")


class TestLogs:
    def _logger(self):
        from sentrinel_fastapi import SentrinelLogHandler

        handler = SentrinelLogHandler()
        logger = logging.getLogger("shop.checkout")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        return logger, handler

    @pytest.mark.parametrize("kind", ["async", "sync"])
    def test_a_log_line_carries_the_request_that_wrote_it(self, build, sent, kind):
        """Sync endpoints run in a worker thread. The request's context has to
        travel with them, or their log lines belong to no request at all."""
        logger, handler = self._logger()
        app = FastAPI()

        if kind == "async":

            @app.get("/pay")
            async def pay():
                logger.info("card declined", extra={"order_id": 42})
                return {}

        else:

            @app.get("/pay")
            def pay():
                logger.info("card declined", extra={"order_id": 42})
                return {}

        try:
            client, collector = build(app)
            client.get("/pay", headers={"traceparent": MOBILE})
            collector.flush()
        finally:
            logger.removeHandler(handler)

        line = sent.rows("/api/ingest/logs", "logs")[0]
        request_row = sent.rows("/api/ingest/requests", "requests")[0]
        assert line["requestId"] == request_row["id"]
        assert line["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"
        assert line["message"] == "card declined" and line["level"] == "info"
        assert line["category"] == "shop.checkout"
        assert line["attributes"]["order_id"] == 42

    def test_a_line_outside_a_request_is_sent_on_its_own(self, build, sent):
        logger, handler = self._logger()
        try:
            client, collector = build(make_app())
            logger.warning("cache warm-up slow")
            collector.flush()
        finally:
            logger.removeHandler(handler)
        line = sent.rows("/api/ingest/logs", "logs")[0]
        assert line["level"] == "warn" and "requestId" not in line


class TestTracePropagation:
    def test_a_request_from_the_app_continues_its_trace(self, build, sent):
        client, collector = build(make_app())
        client.get("/ok", headers={"traceparent": MOBILE})
        collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"

    def test_a_request_with_no_header_starts_its_own_trace(self, build, sent):
        client, collector = build(make_app())
        client.get("/ok")
        collector.flush()
        trace_id = sent.rows("/api/ingest/requests", "requests")[0]["traceId"]
        assert len(trace_id) == 32 and int(trace_id, 16)

    def test_a_forged_header_does_not_become_a_trace_id(self, build, sent):
        client, collector = build(make_app())
        client.get("/ok", headers={"traceparent": "'; drop table traces; --"})
        collector.flush()
        trace_id = sent.rows("/api/ingest/requests", "requests")[0]["traceId"]
        assert len(trace_id) == 32 and "drop" not in trace_id

    def test_an_error_carries_the_trace_so_the_issue_opens_the_waterfall(self, build, sent):
        client, collector = build(make_app(), raise_server_exceptions=False)
        client.get("/boom", headers={"traceparent": MOBILE})
        collector.flush()
        err = sent.rows("/api/ingest/errors", "errors")[0]
        assert err["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"
        assert err["requestLogId"] == sent.rows("/api/ingest/requests", "requests")[0]["id"]

    def test_outgoing_headers_pass_the_chain_on(self, build):
        from sentrinel_fastapi import current_trace, outgoing_headers

        seen = {}
        app = FastAPI()

        @app.get("/call")
        async def call():
            seen["headers"] = outgoing_headers({"accept": "application/json"})
            seen["trace"] = current_trace()
            return {}

        client, _ = build(app)
        client.get("/call", headers={"traceparent": MOBILE})
        header = seen["headers"]["traceparent"]
        assert header.startswith("00-4bf92f3577b34da6a3ce929d0e0e4736-")
        assert seen["headers"]["accept"] == "application/json"
        assert seen["trace"]["parent_span_id"] == "00f067aa0ba902b7"

    def test_outside_a_request_nothing_is_invented(self):
        from sentrinel_fastapi import outgoing_headers

        assert outgoing_headers({"a": "b"}) == {"a": "b"}


class TestSpans:
    def test_spans_ship_as_a_trace_under_the_request(self, build, sent):
        from sentrinel_fastapi import span, traced

        @traced("pricing.quote")
        async def quote(order_id: int):
            await asyncio.sleep(0.02)
            return 10 * order_id

        app = FastAPI()

        @app.get("/orders/{order_id}/total")
        async def total(order_id: int):
            with span("db.query", {"table": "orders"}):
                await asyncio.sleep(0.01)
            return {"total": await quote(order_id)}

        client, collector = build(app)
        assert client.get("/orders/3/total", headers={"traceparent": MOBILE}).json() == {"total": 30}
        collector.flush()

        trace = sent.payload("/api/ingest/traces")
        assert trace["appName"] == "orders"
        assert trace["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"
        assert trace["requestLogId"] == sent.rows("/api/ingest/requests", "requests")[0]["id"]
        root, *children = trace["spans"]
        assert root["kind"] == "SERVER" and root["name"] == "GET /orders/:order_id/total"
        # The phone's span is the server span's parent: one waterfall.
        assert root["parentId"] == "00f067aa0ba902b7"
        by_name = {s["name"]: s for s in children}
        assert by_name["db.query"]["parentId"] == root["id"]
        # An async function's span covers the work, not the creation of the
        # coroutine — which is microseconds and says nothing.
        assert by_name["pricing.quote"]["durationMs"] >= 15

    def test_a_span_in_a_sync_endpoint_joins_the_trace(self, build, sent):
        from sentrinel_fastapi import span

        app = FastAPI()

        @app.get("/report")
        def report():
            with span("render.pdf"):
                time.sleep(0.005)
            return {}

        client, collector = build(app)
        client.get("/report")
        collector.flush()
        names = [s["name"] for s in sent.payload("/api/ingest/traces")["spans"]]
        assert names == ["GET /report", "render.pdf"]

    def test_no_spans_means_no_trace_row(self, build, sent):
        client, collector = build(make_app())
        client.get("/ok")
        collector.flush()
        assert sent.payload("/api/ingest/traces") is None


class TestOutbound:
    @pytest.mark.parametrize("mode", ["async", "sync"])
    def test_an_httpx_call_becomes_a_span_and_carries_the_trace(self, build, sent, mode):
        import httpx

        from sentrinel_fastapi import async_httpx_transport, httpx_transport

        received = {}

        def rates(request: httpx.Request) -> httpx.Response:
            received["traceparent"] = request.headers.get("traceparent")
            return httpx.Response(503, json={"error": "down"})

        app = FastAPI()
        if mode == "async":

            @app.get("/convert")
            async def convert():
                transport = async_httpx_transport(httpx.MockTransport(rates))
                async with httpx.AsyncClient(transport=transport) as client:
                    res = await client.get("https://rates.example.com/v1/usd?key=secret")
                return {"status": res.status_code}

        else:

            @app.get("/convert")
            def convert():
                with httpx.Client(transport=httpx_transport(httpx.MockTransport(rates))) as client:
                    res = client.get("https://rates.example.com/v1/usd?key=secret")
                return {"status": res.status_code}

        client, collector = build(app)
        assert client.get("/convert", headers={"traceparent": MOBILE}).json() == {"status": 503}
        collector.flush()

        spans = sent.payload("/api/ingest/traces")["spans"]
        call = next(s for s in spans if s["kind"] == "CLIENT")
        # Host and path, never the query: it carries the key.
        assert call["name"] == "GET rates.example.com/v1/usd"
        assert call["attributes"]["http.status_code"] == 503
        assert call["statusCode"] == "ERROR"
        # The remote service continues this trace, under this call's span.
        assert received["traceparent"] == f"00-4bf92f3577b34da6a3ce929d0e0e4736-{call['id']}-01"


class TestTunnel:
    def _app(self):
        from sentrinel_fastapi import sentrinel_tunnel

        app = make_app()
        app.add_route("/api/_sentrinel", sentrinel_tunnel, methods=["POST", "GET"])
        return app

    def test_a_batch_is_forwarded_to_the_right_ingest_paths(self, build, sent):
        client, _ = build(self._app())
        res = client.post("/api/_sentrinel", json={"errors": [{"m": 1}], "requests": [{"p": "/"}]})
        assert res.status_code == 200 and res.json() == {"ok": True, "forwarded": 2}
        paths = [p for p, _ in sent.posts]
        assert "/api/ingest/errors" in paths and "/api/ingest/requests" in paths

    def test_the_app_and_the_part_come_from_the_server_not_the_batch(self, build, sent):
        client, _ = build(self._app(), module="api")
        client.post(
            "/api/_sentrinel",
            json={"errors": [{"m": 1}], "appName": "someone-elses-app", "env": "dev", "module": "api"},
        )
        body = sent.payload("/api/ingest/errors")
        assert body["appName"] == "orders" and body["env"] == "prod"
        # The page is its own part of the project, never this server's.
        assert body["module"] == "web"

    def test_the_tunnel_is_not_recorded_as_a_request_of_this_app(self, build, sent):
        client, collector = build(self._app())
        client.post("/api/_sentrinel", json={"errors": [{"m": 1}]})
        sent.posts.clear()
        collector.flush()
        assert sent.payload("/api/ingest/requests") is None
        assert sent.payload("/api/ingest/metrics") is None

    def test_junk_is_refused(self, build):
        client, _ = build(self._app())
        assert client.get("/api/_sentrinel").status_code == 405
        assert client.post("/api/_sentrinel", content=b"not json").status_code == 400
        assert client.post("/api/_sentrinel", content=b"[1, 2]").status_code == 400
        big = b'{"errors": [' + b'{"m": 1},' * 250_000 + b'{"m": 1}]}'
        assert client.post("/api/_sentrinel", content=big).status_code == 413


class TestModule:
    """An app is the whole project; MODULE says which part of it this service is."""

    PATHS = (
        "/api/ingest/requests",
        "/api/ingest/metrics",
        "/api/ingest/logs",
        "/api/ingest/errors",
        "/api/ingest/traces",
        "/api/ingest/custom-metrics",
    )

    def _everything(self, build, sent, **overrides):
        from sentrinel_fastapi import SentrinelLogHandler, count, span

        handler = SentrinelLogHandler()
        logger = logging.getLogger("shop.module")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)

        app = make_app()

        @app.get("/work")
        async def work():
            logger.info("hello")
            with span("db.query"):
                pass
            count("orders.viewed")
            return {}

        try:
            client, collector = build(app, raise_server_exceptions=False, **overrides)
            client.get("/work")
            client.get("/boom")
            collector.flush()
        finally:
            logger.removeHandler(handler)
        bodies = {path: body for path, body in sent.posts}
        assert set(self.PATHS) <= set(bodies), sorted(bodies)
        return bodies

    def test_every_payload_says_which_part_sent_it(self, build, sent):
        bodies = self._everything(build, sent, module="pricing")
        for path in self.PATHS:
            assert bodies[path]["module"] == "pricing", path
            assert bodies[path]["appName"] == "orders", path

    def test_unset_nothing_is_sent_so_the_key_names_the_part(self, build, sent):
        bodies = self._everything(build, sent)
        for path in self.PATHS:
            assert "module" not in bodies[path], path


class TestCollectorLifecycle:
    def test_a_collector_made_by_a_startup_log_line_adopts_the_middlewares_settings(self, sent):
        """A log line written at startup creates the collector from the
        environment alone — before FastAPI builds its middleware, which it does
        on the first request. Keeping that collector unconfigured ignored every
        option passed to add_middleware, and nothing was ever sent."""
        collector_module.reset_collector()
        early = get_collector()
        assert not early.config.configured

        mw = SentrinelMiddleware(make_app(), server_url="http://api.test", app_name="orders")
        assert mw.collector is early
        assert early.config.configured and early.config.app_name == "orders"

    def test_a_second_middleware_joins_rather_than_evicting_the_first(self, sent):
        collector_module.reset_collector()
        first = SentrinelMiddleware(make_app(), server_url="http://api.test", app_name="orders")
        second = SentrinelMiddleware(make_app(), server_url="http://api.test", app_name="billing")
        assert second.collector is first.collector
        # The configured collector is kept: replacing it would drop its buffer.
        assert first.collector.config.app_name == "orders"

    def test_the_environment_configures_it_on_its_own(self, monkeypatch):
        collector_module.reset_collector()
        monkeypatch.setenv("SENTRINEL_SERVER_URL", "http://api.test")
        monkeypatch.setenv("SENTRINEL_APP_NAME", "from-env")
        monkeypatch.setenv("SENTRINEL_MODULE", "worker")
        cfg = load({})
        assert cfg.configured and cfg.app_name == "from-env" and cfg.module == "worker"
        mw = SentrinelMiddleware(make_app())
        assert mw.config.app_name == "from-env"
