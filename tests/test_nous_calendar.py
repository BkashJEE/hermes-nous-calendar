"""Nous Calendar against canned GitHub responses (no network).

Run: python3 tests/test_nous_calendar.py
(the backend tests skip themselves without fastapi; ~/.hermes/hermes-agent/venv/bin/python has it).
"""
import base64
import datetime as dt
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["NOUS_CALENDAR_NO_BACKGROUND"] = "1"
import nous_calendar as n  # noqa: E402

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:
    FastAPI = None

LA = "America/Los_Angeles"


def commit(sha, when, msg):
    return {"sha": sha, "html_url": f"https://github.com/x/commit/{sha}", "commit": {"message": msg, "committer": {"date": when}}}


def entry_yaml(tier, desc):
    text = f"name: x\ntier: {tier}\ndescription: >\n  {desc} Disclosure — reads things.\n"
    return {"content": base64.b64encode(text.encode()).decode()}


class FakeGitHub:
    """Answers the handful of REST paths nous_calendar reads, from tables set per test."""

    def __init__(self):
        self.releases, self.catalog_commits, self.before, self.listings = [], [], [], {}
        self.entries, self.features, self.official, self.merged = {}, [], [], 7
        self.calls = []

    def __call__(self, path, params=None):
        params = params or {}
        self.calls.append(path)
        if path.endswith("/releases"):
            return self.releases if params.get("page", 1) == 1 else []
        if path.endswith("hermes-agent/commits"):
            if "since" not in params:
                return self.before
            return self.catalog_commits if params.get("page", 1) == 1 else []
        if path.endswith("hermes-official-plugins/commits"):
            return self.official if params.get("page", 1) == 1 else []
        if path.endswith("/contents/plugin-catalog"):
            return [{"name": f"{x}.yaml"} for x in self.listings[params["ref"]]]
        if "/contents/plugin-catalog/" in path:
            return self.entries[path.rsplit("/", 1)[1][:-5]]
        if path == "search/issues":
            if "feat in:title" in params["q"]:
                return {"items": self.features if params.get("page", 1) == 1 else []}
            return {"total_count": self.merged}
        raise AssertionError(f"unexpected GitHub path {path}")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        data = Path(self.tmp.name)
        self.gh = FakeGitHub()
        self.patches = [mock.patch.object(n, "DATA", data), mock.patch.object(n, "CACHE", data / "cache.json"),
                        mock.patch.object(n, "api", self.gh), mock.patch.object(n, "auth_mode", lambda: "gh")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()


class Catalog(Base):
    def test_exact_diff_finds_added_plugins_and_their_tier(self):
        g = self.gh
        g.before = [commit("s0", "2026-09-30T20:00:00Z", "older")]
        g.listings = {"s0": ["alpha"], "s1": ["alpha", "beta"], "s2": ["alpha", "beta", "gamma"]}
        # newest first, like GitHub; s2 is Oct 3 local, s1 is Oct 2 local
        g.catalog_commits = [commit("s2", "2026-10-03T18:00:00Z", "plugin-catalog: re-pin beta"),
                             commit("s1", "2026-10-02T18:00:00Z", "plugin-catalog: add beta")]
        g.entries = {"beta": entry_yaml("community", "Beta does a thing."), "gamma": entry_yaml("official", "Gamma ships with Nous.")}
        start, end = n.month_window("2026-10", n.zone(LA))
        out = n.src_catalog(start, end, n.zone(LA), {}, exact=True)
        self.assertEqual([(d["kind"], d["title"]) for d in out], [("catalog", "beta"), ("official", "gamma")])
        self.assertEqual(out[0]["detail"], "Beta does a thing.")
        self.assertNotIn("Disclosure", out[1]["detail"])

    def test_message_mode_skips_repins_and_repeats(self):
        g = self.gh
        g.catalog_commits = [commit("c3", "2026-10-03T18:00:00Z", "catalog: add beta again"),
                             commit("c2", "2026-10-02T18:00:00Z", "plugin-catalog: re-pin alpha to abc"),
                             commit("c1", "2026-10-01T18:00:00Z", "catalog: add beta (official)")]
        start, end = n.month_window("2026-10", n.zone(LA))
        out = n.src_catalog(start, end, n.zone(LA), {}, exact=False)
        self.assertEqual([(d["kind"], d["title"]) for d in out], [("official", "beta")])


class Features(Base):
    def test_feat_titles_kept_plumbing_scopes_dropped(self):
        def pr(num, title):
            return {"number": num, "title": title, "html_url": f"https://github.com/x/pull/{num}",
                    "pull_request": {"merged_at": "2026-10-05T16:00:00Z"}}
        self.gh.features = [pr(1, "feat(desktop): a new pane (#1)"), pr(2, "feat(ci): pin buildx"),
                            pr(3, "fix: not a feature"), pr(4, "feat: voice input"),
                            pr(5, "feat: add hermes-activity to plugin catalog"), pr(6, "feat(plugins): add Tameru 1.4.1 to the plugin catalog")]
        start, end = n.month_window("2026-10", n.zone(LA))
        out = n.src_features(start, end)
        self.assertEqual([d["title"] for d in out], ["a new pane", "voice input"])
        self.assertEqual(out[0]["detail"], "desktop · #1")


class Collect(Base):
    def setUp(self):
        super().setUp()
        self.gh.releases = [
            {"tag_name": "v1", "name": "Hermes v1", "published_at": "2026-10-21T03:00:00Z", "html_url": "u", "body": "## Highlights\nFaster `read_file` and fewer retries. More text."},
            {"tag_name": "v0", "name": "old", "published_at": "2026-09-10T03:00:00Z", "html_url": "u", "body": ""},
            {"tag_name": "v2", "draft": True, "published_at": "2026-10-22T03:00:00Z"},
        ]

    def test_days_are_local_and_cached_month_is_reused(self):
        with mock.patch.object(n.dt, "datetime", wraps=dt.datetime) as fake:
            fake.now.side_effect = lambda tz=None: dt.datetime(2026, 10, 25, 12, tzinfo=tz)
            d = n.collect("2026-10", LA)
        rel = [x for x in d["drops"] if x["kind"] == "release"]
        self.assertEqual([(x["title"], x["day"]) for x in rel], [("Hermes v1", "2026-10-20")])  # 03:00Z = Oct 20 in LA
        self.assertEqual(rel[0]["detail"], "Faster read_file and fewer retries.")
        self.assertTrue(rel[0]["major"])
        self.assertEqual(d["merged"]["2026-10-01"], 7)
        self.assertEqual(d["counts"]["release"], 1)
        calls = len(self.gh.calls)
        again = n.collect("2026-10", LA)  # finished month (from the real clock) or fresh: served from cache
        self.assertTrue(again["cached"])
        self.assertEqual(len(self.gh.calls), calls)

    def test_a_failed_source_is_reported_and_not_cached(self):
        def broken(path, params=None):
            if path.endswith("/releases"):
                raise n.GitHubError("GitHub 403 on releases")
            return self.gh(path, params)
        with mock.patch.object(n, "api", broken):
            d = n.collect("2026-10", LA)
        self.assertIn("releases", d["errors"])
        self.assertNotIn("months", n.load_cache())

    def test_compact_keeps_catalog_names_only(self):
        data = {"drops": [{"id": "catalog:a", "kind": "catalog", "day": "d", "at": "t", "title": "a", "label": "l", "major": False, "detail": "long", "url": "u", "repo": "r"},
                          {"id": "release:v", "kind": "release", "day": "d", "at": "t", "title": "v", "label": "l", "major": True, "detail": "x", "url": "u", "repo": "r"}]}
        slim = n.compact(data)["drops"]
        self.assertNotIn("detail", slim[0])
        self.assertEqual(slim[1]["detail"], "x")


class Summary(Base):
    def test_groups_by_day_and_names_catalog_plugins(self):
        today = dt.datetime.now(n.zone(LA)).date()
        fake = {"tz": LA, "merged": {str(today): 40}, "errors": {}, "drops": [
            {"kind": "release", "day": str(today), "title": "v9", "detail": "", "url": "u"},
            {"kind": "catalog", "day": str(today), "title": "beta"},
            {"kind": "feature", "day": str(today - dt.timedelta(days=20)), "title": "old", "detail": "", "url": ""}]}
        with mock.patch.object(n, "collect", return_value=fake):
            s = n.summary("week", LA)
        day = s["days"][str(today)]
        self.assertEqual(day["new_in_catalog"], ["beta"])
        self.assertEqual(day["releases"][0]["title"], "v9")
        self.assertEqual(day["merged_prs"], 40)
        self.assertEqual(len(s["days"]), 1)


class OnX(Base):
    def write(self, payload):
        path = Path(self.tmp.name) / "x.json"
        path.write_text(json.dumps(payload) if not isinstance(payload, str) else payload)
        return path

    def test_no_file_means_github_only(self):
        with mock.patch.dict(os.environ, {"NOUS_CALENDAR_X_FILE": str(Path(self.tmp.name) / "missing.json")}):
            self.assertIsNone(n.src_x("2026-10"))
        self.assertIsNone(n.src_x("2026-10"))  # default path under the plugin's data dir doesn't exist either

    def test_reads_only_the_month_and_never_the_network(self):
        path = self.write({"tz": LA, "updated": "2026-10-22", "days": {
            "2026-10-21": {"types": ["release", "launch"], "head": "A · B", "big": [{"author": "x", "views": "969K"}]},
            "2026-09-30": {"types": ["news"], "head": "old"}}})
        with mock.patch.dict(os.environ, {"NOUS_CALENDAR_X_FILE": str(path)}), \
             mock.patch.object(n.urllib.request, "urlopen", side_effect=AssertionError("no network for X")):
            x = n.src_x("2026-10")
        self.assertEqual(list(x["days"]), ["2026-10-21"])
        self.assertEqual(x["updated"], "2026-10-22")

    def test_a_broken_file_is_reported_not_fatal(self):
        path = self.write("{not json")
        with mock.patch.dict(os.environ, {"NOUS_CALENDAR_X_FILE": str(path)}):
            self.assertIn("couldn't read", n.src_x("2026-10")["error"])

    def test_x_layer_is_attached_but_never_cached(self):
        path = self.write({"days": {"2026-10-02": {"types": ["launch"], "head": "secret curated line"}}})
        with mock.patch.dict(os.environ, {"NOUS_CALENDAR_X_FILE": str(path)}):
            d = n.collect("2026-10", LA)
        self.assertIn("2026-10-02", d["x"]["days"])
        self.assertNotIn("secret curated line", n.CACHE.read_text())


class Background(Base):
    def test_reads_github_once_per_window(self):
        with mock.patch.object(n, "collect") as collect:
            self.assertTrue(n.background_refresh())
            self.assertFalse(n.background_refresh())
        self.assertGreaterEqual(collect.call_count, 1)
        cache = n.load_cache()
        cache["bg_at"] = time.time() - n.BG_EVERY_S - 1
        n.save_cache(cache)
        with mock.patch.object(n, "collect"):
            self.assertTrue(n.background_refresh())

    def test_a_read_killed_half_way_retries_after_the_claim_not_six_hours(self):
        with mock.patch.object(n, "collect", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                n.background_refresh()
        self.assertNotIn("bg_at", n.load_cache())
        with mock.patch.object(n, "collect"):
            self.assertFalse(n.background_refresh())   # another process may still be reading
        cache = n.load_cache()
        cache["bg_claim"] = time.time() - n.BG_CLAIM_S - 1
        n.save_cache(cache)
        with mock.patch.object(n, "collect"):
            self.assertTrue(n.background_refresh())


class Text(unittest.TestCase):
    def test_first_line_keeps_snake_case_and_drops_markdown(self):
        self.assertEqual(n.first_line("# Title\n**Bold** use `web_extract` and _soft_ text. Next."), "Bold use web_extract and soft text.")


@unittest.skipIf(FastAPI is None, "fastapi not installed; run with ~/.hermes/hermes-agent/venv/bin/python")
class Backend(Base):
    def setUp(self):
        super().setUp()
        sys.modules["hermes_nous_calendar_script"] = n
        spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_hermes-nous-calendar", ROOT / "dashboard" / "plugin_api.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        app = FastAPI()
        app.include_router(mod.router, prefix="/api/plugins/hermes-nous-calendar")
        self.c = TestClient(app)
        self.u = "/api/plugins/hermes-nous-calendar"

    def tearDown(self):
        sys.modules.pop("hermes_nous_calendar_script", None)
        super().tearDown()

    def test_health_and_validation(self):
        self.assertTrue(self.c.get(f"{self.u}/health").json()["ok"])
        self.assertEqual(self.c.get(f"{self.u}/month?month=2026-13").status_code, 400)
        self.assertEqual(self.c.get(f"{self.u}/month?tz=$(rm)").status_code, 400)

    def test_month_passes_through(self):
        with mock.patch.object(n, "collect", return_value={"drops": [], "ok": 1}) as collect:
            r = self.c.get(f"{self.u}/month?month=2026-10&tz={LA}&refresh=true").json()
        self.assertEqual(r["ok"], 1)
        self.assertEqual(collect.call_args[0], ("2026-10", LA, True))


class Plugin(unittest.TestCase):
    def test_tool_returns_json_even_on_failure(self):
        spec = importlib.util.spec_from_file_location("hnc_pkg", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
        mod = importlib.util.module_from_spec(spec)
        sys.modules["hnc_pkg"] = mod
        spec.loader.exec_module(mod)
        with mock.patch.object(mod.commands._cal(), "summary", side_effect=RuntimeError("offline")):
            out = json.loads(mod._tool({"period": "today"}))
        self.assertIn("offline", out["error"])
        reg = mock.Mock()
        mod.register(reg)
        self.assertEqual(reg.register_tool.call_args.kwargs["name"], "nous_calendar")
        self.assertEqual(reg.register_skill.call_args[0][0], "nous-calendar")


if __name__ == "__main__":
    unittest.main(verbosity=2)
