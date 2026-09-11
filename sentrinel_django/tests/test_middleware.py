"""Real requests through the real middleware, with the network stubbed.

What these pin down is the contract with the API — field names and shapes — and
the promise that telemetry never changes what the application returns.
"""

import json

import pytest
from django.test import RequestFactory

from sentrinel_django import collector as collector_module
from sentrinel_django import metrics
from sentrinel_django.config import load
from sentrinel_django.middleware import SentrinelMiddleware


class Captured:
    """Stands in for the network, and remembers what would have been sent."""

    def __init__(self):
        self.posts = []

    def install(self, collector):
        collector._post = lambda path, payload, attempt=0: self.posts.append((path, payload))
        return collector

    def payload(self, path):
        for p, body in self.posts:
            if p == path:
                return body
        return None

    def rows(self, path, key):
        body = self.payload(path)
        return body[key] if body else []


@pytest.fixture
def sent():
    return Captured()


@pytest.fixture
def build(sent):
    """A middleware wired to a stubbed collector, with whatever config."""

    def _build(view=None, **overrides):
        cfg = load({"SERVER_URL": "http://api.test", "APP_NAME": "orders", "ENV": "prod", **overrides})
        collector_module.reset_collector()
        collector = sent.install(collector_module.Collector(cfg))
        collector_module.set_collector(collector)
        # The flusher would otherwise start a thread per test.
        collector._ensure_started = lambda: None
        mw = SentrinelMiddleware(view or (lambda r: __import__("django.http", fromlist=["HttpResponse"]).HttpResponse("ok")))
        mw.config = cfg
        mw.collector = collector
        return mw

    return _build


@pytest.fixture(autouse=True)
def _clean():
    metrics._registry = metrics.MetricRegistry()
    yield
    collector_module.reset_collector()


rf = RequestFactory()


class TestRequestCapture:
    def test_a_request_produces_a_row_the_api_accepts(self, build, sent):
        mw = build()
        mw(rf.get("/ok/"))
        mw.collector.flush()

        body = sent.payload("/api/ingest/requests")
        assert body["appName"] == "orders" and body["env"] == "prod"
        row = body["requests"][0]
        # Exactly the field names the ingest route reads.
        for key in ("id", "method", "path", "route", "statusCode", "responseTime", "timestamp", "sampleRate"):
            assert key in row, key
        assert row["method"] == "GET" and row["statusCode"] == 200
        assert row["responseTime"] >= 0

    def test_the_response_is_unchanged(self, build):
        from django.http import HttpResponse

        mw = build(lambda r: HttpResponse("payload", status=201))
        res = mw(rf.get("/ok/"))
        assert res.status_code == 201 and res.content == b"payload"

    def test_metrics_roll_up_instead_of_one_row_per_request(self, build, sent):
        mw = build()
        for _ in range(50):
            mw(rf.get("/ok/"))
        mw.collector.flush()

        endpoints = sent.rows("/api/ingest/metrics", "endpoints")
        assert len(endpoints) == 1
        assert endpoints[0]["requestCount"] == 50 and endpoints[0]["successCount"] == 50
        for key in ("p50ResponseTime", "p95ResponseTime", "p99ResponseTime", "statusCodes"):
            assert key in endpoints[0]

    def test_excluded_paths_are_not_recorded(self, build, sent):
        mw = build(EXCLUDE_PATHS=[r"^/health"])
        mw(rf.get("/health/"))
        mw.collector.flush()
        assert sent.payload("/api/ingest/requests") is None

    def test_credentials_are_masked_before_buffering(self, build, sent):
        mw = build()
        mw(rf.get("/ok/", HTTP_AUTHORIZATION="Bearer secret-token", HTTP_ACCEPT="application/json"))
        mw.collector.flush()
        headers = sent.rows("/api/ingest/requests", "requests")[0]["requestHeaders"]
        assert headers["authorization"] == "***"
        assert headers["accept"] == "application/json"
        assert "secret-token" not in json.dumps(sent.posts, default=str)

    def test_query_secrets_are_masked(self, build, sent):
        mw = build()
        mw(rf.get("/ok/?page=2&api_key=live-key"))
        mw.collector.flush()
        params = sent.rows("/api/ingest/requests", "requests")[0]["queryParams"]
        assert params["page"] == "2" and params["api_key"] == "***"

    def test_bodies_are_off_unless_asked_for(self, build, sent):
        mw = build()
        mw(rf.post("/ok/", data=json.dumps({"password": "x"}), content_type="application/json"))
        mw.collector.flush()
        assert "requestBody" not in sent.rows("/api/ingest/requests", "requests")[0]

    def test_a_captured_body_is_masked(self, build, sent):
        mw = build(LOG_REQUEST_BODY=True)
        mw(rf.post("/ok/", data=json.dumps({"user": "a", "password": "hunter2"}), content_type="application/json"))
        mw.collector.flush()
        body = json.loads(sent.rows("/api/ingest/requests", "requests")[0]["requestBody"])
        assert body["password"] == "***" and body["user"] == "a"

    def test_the_client_ip_is_the_caller_not_the_proxy(self, build, sent):
        mw = build()
        mw(rf.get("/ok/", HTTP_X_FORWARDED_FOR="203.0.113.7, 10.0.0.1, 10.0.0.2"))
        mw.collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["clientIp"] == "203.0.113.7"


class TestErrors:
    def test_a_view_exception_is_captured_and_still_raised(self, build, sent):
        def boom(request):
            raise ValueError("kaboom")

        mw = build(boom)
        request = rf.get("/boom/")
        with pytest.raises(ValueError):
            response = mw(request)  # noqa: F841
        # Django calls process_exception itself; the middleware contract is
        # that it records when asked.
        mw.process_exception(request, ValueError("kaboom"))
        mw.collector.flush()

        err = sent.rows("/api/ingest/errors", "errors")[0]
        assert err["errorType"] == "ValueError" and err["errorMessage"] == "kaboom"
        assert "Traceback" in err["stackTrace"] or "ValueError" in err["stackTrace"]
        assert err["statusCode"] == 500

    def test_an_error_is_never_sampled_away(self, build, sent):
        from django.http import HttpResponse

        mw = build(lambda r: HttpResponse("no", status=500), SAMPLE_RATE=0.0)
        mw(rf.get("/ok/"))
        mw.collector.flush()
        rows = sent.rows("/api/ingest/requests", "requests")
        assert len(rows) == 1 and rows[0]["sampleRate"] == 1

    def test_ordinary_traffic_is_sampled_away_at_rate_zero(self, build, sent):
        mw = build(SAMPLE_RATE=0.0)
        mw(rf.get("/ok/"))
        mw.collector.flush()
        assert sent.payload("/api/ingest/requests") is None
        # …but it still counted, because metrics are exact regardless of sampling.
        assert sent.rows("/api/ingest/metrics", "endpoints")[0]["requestCount"] == 1


    def test_an_error_reports_the_route_so_it_shares_the_endpoint(self, build, sent):
        """An error's path registers an endpoint, same as a request's route.

        Sending the raw URL here created a twin: /boom/ beside /boom, with the
        endpoint's error count split away from its traffic. Caught end to end
        against a real API, not by a unit test.
        """
        from django.test import RequestFactory
        from django.urls import ResolverMatch

        mw = build()
        request = RequestFactory().get("/orders/1042/")
        request.resolver_match = ResolverMatch(func=lambda r: None, args=(), kwargs={}, url_name="d", route="orders/<int:pk>/")
        mw.process_exception(request, ValueError("x"))
        mw.collector.flush()

        assert sent.rows("/api/ingest/errors", "errors")[0]["path"] == "/orders/:pk"


class TestIdentity:
    def test_a_custom_resolver_names_the_consumer(self, build, sent):
        mw = build(CONSUMER_IDENTIFIER=lambda request: "tenant-42")
        mw(rf.get("/ok/"))
        mw.collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["consumerIdentifier"] == "tenant-42"
        assert sent.rows("/api/ingest/metrics", "consumers")[0]["identifier"] == "tenant-42"

    def test_a_broken_resolver_does_not_break_the_request(self, build, sent):
        def explode(request):
            raise RuntimeError("bad resolver")

        mw = build(CONSUMER_IDENTIFIER=explode)
        res = mw(rf.get("/ok/"))
        assert res.status_code == 200
        mw.collector.flush()
        assert sent.rows("/api/ingest/requests", "requests")[0]["consumerIdentifier"] is None

    def test_context_added_in_a_view_lands_on_the_row(self, build, sent):
        from django.http import HttpResponse

        from sentrinel_django import add_context, set_consumer

        def view(request):
            add_context(tier="enterprise", order_id=7)
            set_consumer("acme")
            return HttpResponse("ok")

        mw = build(view)
        mw(rf.get("/ok/"))
        mw.collector.flush()
        row = sent.rows("/api/ingest/requests", "requests")[0]
        assert row["attributes"] == {"tier": "enterprise", "order_id": 7}
        assert row["consumerIdentifier"] == "acme"


class TestLogs:
    def test_a_log_line_carries_the_request_that_wrote_it(self, build, sent):
        import logging

        from django.http import HttpResponse

        from sentrinel_django import SentrinelLogHandler

        handler = SentrinelLogHandler()
        logger = logging.getLogger("shop.checkout")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)

        def view(request):
            logger.info("card declined", extra={"order_id": 42})
            return HttpResponse("ok")

        try:
            mw = build(view)
            mw(rf.get("/ok/"))
            mw.collector.flush()
        finally:
            logger.removeHandler(handler)

        line = sent.rows("/api/ingest/logs", "logs")[0]
        request_row = sent.rows("/api/ingest/requests", "requests")[0]
        # The correlation is the point: same id, so the line opens its request.
        assert line["requestId"] == request_row["id"]
        assert line["message"] == "card declined"
        assert line["level"] == "info"
        assert line["category"] == "shop.checkout"
        assert line["attributes"]["order_id"] == 42


class TestCustomMetrics:
    def test_counters_ride_the_same_flush(self, build, sent):
        from sentrinel_django import count

        mw = build()
        for _ in range(500):
            count("llm.tokens", 3, {"model": "deepseek"})
        mw.collector.flush()

        body = sent.payload("/api/ingest/custom-metrics")
        assert body["appName"] == "orders"
        assert len(body["metrics"]) == 1
        assert body["metrics"][0]["sum"] == 1500


class TestCollectorLifecycle:
    def test_a_second_middleware_joins_rather_than_evicting_the_first(self, build, sent):
        """Django can build more than one middleware instance in a process.

        An earlier version replaced the process collector whenever one was
        constructed with a config, which silently discarded everything the
        first had buffered — and the log handler, which looks the collector up
        by itself, then shipped to an instance nobody was flushing.
        """
        mw = build()
        mw(rf.get("/ok/"))  # buffered, not yet flushed

        second = SentrinelMiddleware(lambda r: __import__("django.http", fromlist=["HttpResponse"]).HttpResponse("ok"))
        assert second.collector is mw.collector

        mw.collector.flush()
        assert len(sent.rows("/api/ingest/requests", "requests")) == 1


class TestTracePropagation:
    """Mobile → backend on one trace, which is the point of the header."""

    MOBILE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    def test_a_request_from_the_app_continues_its_trace(self, build, sent):
        mw = build()
        mw(rf.get("/ok/", HTTP_TRACEPARENT=self.MOBILE))
        mw.collector.flush()
        row = sent.rows("/api/ingest/requests", "requests")[0]
        # Same trace as the tap that caused it, not a fresh one.
        assert row["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"

    def test_a_request_with_no_header_starts_its_own_trace(self, build, sent):
        mw = build()
        mw(rf.get("/ok/"))
        mw.collector.flush()
        row = sent.rows("/api/ingest/requests", "requests")[0]
        assert len(row["traceId"]) == 32

    def test_a_forged_header_does_not_become_a_trace_id(self, build, sent):
        mw = build()
        mw(rf.get("/ok/", HTTP_TRACEPARENT="'; drop table --"))
        mw.collector.flush()
        row = sent.rows("/api/ingest/requests", "requests")[0]
        assert row["traceId"] != "'; drop table --"
        assert len(row["traceId"]) == 32

    def test_log_lines_carry_the_same_trace_and_a_span(self, build, sent):
        import logging

        from django.http import HttpResponse

        from sentrinel_django import SentrinelLogHandler

        handler = SentrinelLogHandler()
        logger = logging.getLogger("trace.test")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)

        def view(request):
            logger.info("inside the trace")
            return HttpResponse("ok")

        try:
            mw = build(view)
            mw(rf.get("/ok/", HTTP_TRACEPARENT=self.MOBILE))
            mw.collector.flush()
        finally:
            logger.removeHandler(handler)

        line = sent.rows("/api/ingest/logs", "logs")[0]
        assert line["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"
        assert len(line["spanId"]) == 16

    def test_an_error_carries_the_trace_so_the_issue_opens_the_waterfall(self, build, sent):
        from django.http import HttpResponse

        # Django calls process_exception *during* the request, while the
        # context is still live — calling it afterwards is what a test does,
        # not what the framework does, and the error would lose its trace.
        holder = {}

        def view(request):
            try:
                raise ValueError("x")
            except ValueError as exc:
                holder["mw"].process_exception(request, exc)
                return HttpResponse(status=500)

        mw = build(view)
        holder["mw"] = mw
        mw(rf.get("/boom/", HTTP_TRACEPARENT=self.MOBILE))
        mw.collector.flush()

        err = sent.rows("/api/ingest/errors", "errors")[0]
        assert err["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"
        # And the request row shares it, so the issue opens the waterfall.
        assert sent.rows("/api/ingest/requests", "requests")[0]["traceId"] == err["traceId"]

    def test_outgoing_headers_pass_the_chain_on(self, build):
        from django.http import HttpResponse

        from sentrinel_django import outgoing_headers

        captured = {}

        def view(request):
            captured.update(outgoing_headers({"content-type": "application/json"}))
            return HttpResponse("ok")

        mw = build(view)
        mw(rf.get("/ok/", HTTP_TRACEPARENT=self.MOBILE))

        # Same trace continues downstream; the span is this service's, so the
        # next hop hangs off our work rather than off the phone's.
        assert captured["traceparent"].startswith("00-4bf92f3577b34da6a3ce929d0e0e4736-")
        assert not captured["traceparent"].startswith("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7")
        assert captured["content-type"] == "application/json"

    def test_outside_a_request_nothing_is_invented(self):
        from sentrinel_django import current_trace, outgoing_headers

        assert outgoing_headers({"a": "b"}) == {"a": "b"}
        assert current_trace()["trace_id"] is None


class TestSpans:
    """A request row says a page took 900ms. A trace says which call it was."""

    def test_spans_ship_as_a_trace_under_the_request(self, build, sent):
        from django.http import HttpResponse

        from sentrinel_django import span

        def view(request):
            with span("db.query", {"table": "orders"}):
                pass
            return HttpResponse("ok")

        mw = build(view)
        mw(rf.get("/ok/"))
        mw.collector.flush()

        trace = sent.payload("/api/ingest/traces")
        assert trace["appName"] == "orders"
        names = [s["name"] for s in trace["spans"]]
        assert "db.query" in names
        # The server span is first and is the parent of the work it did.
        root = trace["spans"][0]
        child = next(s for s in trace["spans"] if s["name"] == "db.query")
        assert root["kind"] == "SERVER"
        assert child["parentId"] == root["id"]
        assert trace["requestLogId"] == sent.rows("/api/ingest/requests", "requests")[0]["id"]

    def test_nesting_follows_the_code(self, build, sent):
        from django.http import HttpResponse

        from sentrinel_django import span

        def view(request):
            with span("outer"):
                with span("inner"):
                    pass
            return HttpResponse("ok")

        mw = build(view)
        mw(rf.get("/ok/"))
        mw.collector.flush()

        spans = {s["name"]: s for s in sent.payload("/api/ingest/traces")["spans"]}
        assert spans["inner"]["parentId"] == spans["outer"]["id"]

    def test_a_raising_span_is_marked_and_the_error_still_propagates(self, build, sent):
        from django.http import HttpResponse

        from sentrinel_django import span

        def view(request):
            try:
                with span("risky"):
                    raise ValueError("nope")
            except ValueError:
                pass
            return HttpResponse("ok")

        mw = build(view)
        mw(rf.get("/ok/"))
        mw.collector.flush()

        risky = next(s for s in sent.payload("/api/ingest/traces")["spans"] if s["name"] == "risky")
        assert risky["statusCode"] == "ERROR"
        assert "ValueError" in risky["statusMessage"]

    def test_no_spans_means_no_trace_row(self, build, sent):
        # A trace holding only its own server span repeats the request row.
        mw = build()
        mw(rf.get("/ok/"))
        mw.collector.flush()
        assert sent.payload("/api/ingest/traces") is None

    def test_the_traced_decorator_names_the_function(self, build, sent):
        from django.http import HttpResponse

        from sentrinel_django import traced

        @traced()
        def price_it():
            return 1

        def view(request):
            price_it()
            return HttpResponse("ok")

        mw = build(view)
        mw(rf.get("/ok/"))
        mw.collector.flush()
        assert any("price_it" in s["name"] for s in sent.payload("/api/ingest/traces")["spans"])

    def test_a_span_outside_a_request_is_inert_not_an_error(self):
        from sentrinel_django import span

        with span("orphan") as s:
            s["attributes"]["x"] = 1  # must not raise

    def test_the_span_tree_joins_the_incoming_trace(self, build, sent):
        from django.http import HttpResponse

        from sentrinel_django import span

        def view(request):
            with span("work"):
                pass
            return HttpResponse("ok")

        mw = build(view)
        mw(rf.get("/ok/", HTTP_TRACEPARENT="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"))
        mw.collector.flush()

        trace = sent.payload("/api/ingest/traces")
        assert trace["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"
        # The phone's span is the parent of our server span, so one waterfall.
        assert trace["spans"][0]["parentId"] == "00f067aa0ba902b7"


class TestResourceUsage:
    def test_cpu_and_memory_ride_the_metrics_payload(self, build, sent):
        mw = build()
        mw(rf.get("/ok/"))
        mw.collector.flush()
        usage = sent.payload("/api/ingest/metrics").get("resourceUsage")
        # Exactly the field names the ingest route reads — inventing clearer
        # ones produced rows of nulls that looked like the feature was off.
        assert usage and usage["memoryRss"] > 0
        assert usage["cpuUsage"] >= 0
        # Named, because gunicorn runs several workers and their numbers must
        # not average into something that describes none of them.
        assert usage["instanceId"]


class TestTunnel:
    """The browser SDK holds no key; this forwards its batches."""

    def _post(self, body):
        import json as _json

        return rf.post("/api/_sentrinel", data=_json.dumps(body), content_type="application/json")

    def test_a_batch_is_forwarded_to_the_right_ingest_paths(self, build, sent):
        from sentrinel_django import sentrinel_tunnel

        build()  # installs the stubbed collector
        res = sentrinel_tunnel(self._post({"errors": [{"m": 1}], "requests": [{"p": "/"}]}))
        assert res.status_code == 200

        paths = [p for p, _ in sent.posts]
        assert "/api/ingest/errors" in paths and "/api/ingest/requests" in paths

    def test_the_app_name_comes_from_settings_not_the_batch(self, build, sent):
        from sentrinel_django import sentrinel_tunnel

        build()
        # Anyone who finds the URL must not be able to write into another app.
        sentrinel_tunnel(self._post({"errors": [{"m": 1}], "appName": "someone-elses-app", "env": "prod"}))
        body = sent.payload("/api/ingest/errors")
        assert body["appName"] == "orders"

    def test_junk_is_refused(self, build):
        from sentrinel_django import sentrinel_tunnel

        build()
        assert sentrinel_tunnel(rf.get("/api/_sentrinel")).status_code == 405
        assert sentrinel_tunnel(rf.post("/api/_sentrinel", data=b"not json", content_type="application/json")).status_code == 400


class TestOutbound:
    def test_a_call_becomes_a_span_and_carries_the_trace(self, build, sent):
        from django.http import HttpResponse

        from sentrinel_django import SentrinelSession

        seen = {}

        class FakeSession:
            def request(self, method, url, **kw):
                seen["headers"] = kw.get("headers") or {}
                seen["method"] = method
                return type("R", (), {"status_code": 200})()

        def view(request):
            SentrinelSession(FakeSession()).get("https://api.example.com/rates?key=secret")
            return HttpResponse("ok")

        mw = build(view)
        mw(rf.get("/ok/", HTTP_TRACEPARENT="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"))
        mw.collector.flush()

        # The downstream service is handed the same trace.
        assert seen["headers"]["traceparent"].startswith("00-4bf92f3577b34da6a3ce929d0e0e4736-")
        span = next(s for s in sent.payload("/api/ingest/traces")["spans"] if s["kind"] == "CLIENT")
        assert span["name"] == "GET api.example.com/rates"
        # The query string carried a secret and is not in the name or the url.
        assert "secret" not in json.dumps(sent.posts)
        assert span["attributes"]["http.status_code"] == 200
