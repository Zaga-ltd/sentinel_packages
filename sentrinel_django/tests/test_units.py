"""The pure pieces: sampling, route templating, masking, metric folding."""

import json
import re

from sentrinel_django import metrics
from sentrinel_django.config import DEFAULT_MASK_FIELDS, DEFAULT_MASK_HEADERS, load, _compile
from sentrinel_django.masking import mask_body, mask_mapping, mask_structure
from sentrinel_django.routes import normalise_django_route, template_path
from sentrinel_django.sampling import should_capture


class TestSampling:
    def test_errors_are_never_sampled_away(self):
        # The row somebody is about to go looking for.
        for status in (400, 404, 500, 503):
            d = should_capture(status, 5, sample_rate=0.0)
            assert d.capture and d.sample_rate == 1

    def test_slow_requests_are_never_sampled_away(self):
        d = should_capture(200, 5000, sample_rate=0.0, slow_request_ms=2000)
        assert d.capture and d.sample_rate == 1

    def test_ordinary_traffic_obeys_the_rate(self):
        class Never:
            def random(self):
                return 0.99

        class Always:
            def random(self):
                return 0.01

        assert should_capture(200, 5, 0.1, rand=Never()).capture is False
        assert should_capture(200, 5, 0.1, rand=Always()).capture is True

    def test_the_rate_travels_with_the_row(self):
        # The dashboard scales counts back up by it; a wrong value is a wrong
        # request count, silently.
        class Always:
            def random(self):
                return 0.0

        assert should_capture(200, 5, 0.25, rand=Always()).sample_rate == 0.25

    def test_a_rate_of_one_keeps_everything(self):
        assert should_capture(200, 5, 1.0).capture is True


class TestRoutes:
    def test_django_patterns_become_sentrinel_routes(self):
        assert normalise_django_route("orders/<int:pk>/") == "/orders/:pk"
        assert normalise_django_route("v1/users/<uuid:id>/posts/") == "/v1/users/:id/posts"
        assert normalise_django_route("") == ""
        assert normalise_django_route("/") == "/"

    def test_regex_routes_too(self):
        assert normalise_django_route(r"^articles/(?P<year>[0-9]{4})/$") == "/articles/:year"

    def test_ids_collapse_so_the_endpoint_list_stays_countable(self):
        assert template_path("/orders/1042") == "/orders/:id"
        assert template_path("/users/3f9a1c2e") == "/users/:id"
        assert template_path("/u/550e8400-e29b-41d4-a716-446655440000") == "/u/:id"

    def test_english_words_are_not_ids(self):
        # A length rule alone turns these into wildcards and merges unrelated
        # endpoints; the digit requirement is what prevents it.
        for word in ("/api/facade/render", "/api/settings/theme", "/api/profile"):
            assert template_path(word) == word


class TestMasking:
    HEADERS = _compile(DEFAULT_MASK_HEADERS)
    FIELDS = _compile(DEFAULT_MASK_FIELDS)

    def test_credentials_never_leave_the_process(self):
        masked = mask_mapping(
            {"authorization": "Bearer abc", "cookie": "s=1", "accept": "application/json"},
            self.HEADERS,
        )
        assert masked["authorization"] == "***"
        assert masked["cookie"] == "***"
        assert masked["accept"] == "application/json"

    def test_nested_body_fields_are_masked_at_any_depth(self):
        body = json.dumps({"user": {"email": "a@b.c", "password": "hunter2"}, "card_number": "4111"})
        out = json.loads(mask_body(body, self.FIELDS, 10_000))
        assert out["user"]["password"] == "***"
        assert out["card_number"] == "***"
        assert out["user"]["email"] == "a@b.c"  # not a secret, kept

    def test_lists_of_objects_are_walked(self):
        out = mask_structure({"items": [{"token": "t1"}, {"token": "t2"}]}, self.FIELDS)
        assert [i["token"] for i in out["items"]] == ["***", "***"]

    def test_oversized_bodies_are_truncated_not_dropped(self):
        out = mask_body("x" * 5000, self.FIELDS, 100)
        assert out is not None and len(out) < 200 and out.endswith("[truncated]")

    def test_non_json_is_kept_as_text(self):
        assert mask_body(b"name=a&password=b", self.FIELDS, 1000).startswith("name=")

    def test_recursion_is_bounded(self):
        deep = current = {}
        for _ in range(200):
            current["next"] = {}
            current = current["next"]
        mask_structure(deep, self.FIELDS)  # must not RecursionError


class TestConfig:
    def test_project_patterns_extend_the_defaults(self):
        # Adding a header must not mean "and start sending Authorization".
        cfg = load({"SERVER_URL": "http://x", "APP_NAME": "a", "MASK_HEADERS": [r"^x-internal$"]})
        names = [p.pattern for p in cfg.mask_headers]
        assert r"^authorization$" in names and r"^x-internal$" in names

    def test_a_trailing_slash_on_the_url_is_not_a_different_server(self):
        assert load({"SERVER_URL": "http://x/", "APP_NAME": "a"}).server_url == "http://x"

    def test_unconfigured_is_inert(self):
        assert load({}).configured is False

    def test_environment_fills_in_what_settings_omit(self, monkeypatch):
        monkeypatch.setenv("SENTRINEL_API_KEY", "snt_live_abc")
        monkeypatch.setenv("SENTRINEL_APP_NAME", "from-env")
        cfg = load({"SERVER_URL": "http://x"})
        assert cfg.api_key == "snt_live_abc" and cfg.app_name == "from-env"


class TestMetrics:
    def setup_method(self):
        metrics._registry = metrics.MetricRegistry()

    def test_increments_fold_into_one_row_per_series(self):
        for _ in range(2000):
            metrics.count("llm.tokens", 1, {"model": "x"})
        points = metrics.registry().drain("2026-01-01T00:00:00Z")
        assert len(points) == 1 and points[0]["sum"] == 2000 and points[0]["count"] == 2000

    def test_label_order_does_not_split_a_series(self):
        metrics.count("a", 1, {"x": "1", "y": "2"})
        metrics.count("a", 1, {"y": "2", "x": "1"})
        assert len(metrics.registry().drain("t")) == 1

    def test_nan_and_infinity_are_refused(self):
        metrics.count("a", float("nan"))
        metrics.count("a", float("inf"))
        assert metrics.registry().drain("t") == []

    def test_series_are_capped_rather_than_growing_without_bound(self):
        for i in range(metrics.MAX_SERIES + 50):
            metrics.count("a", 1, {"user_id": str(i)})
        reg = metrics.registry()
        assert reg.size == metrics.MAX_SERIES and reg.dropped_series == 50

    def test_histograms_report_percentiles(self):
        for i in range(1, 101):
            metrics.histogram("latency", i)
        p = metrics.registry().drain("t")[0]
        assert p["p50"] == 50 and p["p95"] == 95 and p["p99"] == 99

    def test_a_gauge_reports_its_last_reading(self):
        for v in (5, 9, 2):
            metrics.gauge("queue.depth", v)
        assert metrics.registry().drain("t")[0]["last"] == 2

    def test_draining_resets_so_a_gauge_leaves_a_gap(self):
        metrics.gauge("q", 1)
        metrics.registry().drain("t")
        assert metrics.registry().drain("t") == []
