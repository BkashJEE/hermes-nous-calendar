#!/usr/bin/env python3
"""Nous Calendar: what Nous Research shipped for Hermes Agent, day by day.

Reads public GitHub data only and makes no model calls:

  * releases of NousResearch/hermes-agent                      -> "release"
  * plugins added to hermes-agent's plugin-catalog/            -> "official" (tier official) or "catalog"
  * merged hermes-agent PRs titled feat(...)                   -> "feature"
  * feat(...) commits in NousResearch/hermes-official-plugins  -> "plugin-update"
  * every merged hermes-agent PR, counted per day              -> "merged" (shown folded, never listed)

Catalog additions are exact: the plugin-catalog/ listing is read at the last catalog commit of each
day and compared with the day before. Everything is bucketed into days in the reader's own time zone.

Optional "On X" layer: a LOCAL JSON file of curated X posts (Hermes Daily Drops shape: {tz, updated, days:
{"YYYY-MM-DD": {types, head, by, time, url, tags, team, big}}}). Nothing is fetched for it and nothing ships with
the plugin. The file is read only if it exists: NOUS_CALENDAR_X_FILE, else <HERMES_HOME>/plugin-data/
hermes-nous-calendar/x-drops.json. Without it the calendar is GitHub-only.

GitHub access, in order: the `gh` CLI if it is signed in, else GITHUB_TOKEN / GH_TOKEN, else anonymous.
Anonymous GitHub allows 60 calls an hour, so without a sign-in the catalog falls back to reading
commit messages and the per-day merged count is skipped.

Runs standalone too:  python3 nous_calendar.py [--month 2026-10] [--json] [--week|--today]
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

VERSION = "0.1.0"
CORE = "NousResearch/hermes-agent"
OFFICIAL = "NousResearch/hermes-official-plugins"
CATALOG_DIR = "plugin-catalog"

HERMES = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
DATA = HERMES / "plugin-data" / "hermes-nous-calendar"
CACHE = DATA / "cache.json"
FRESH_S = 15 * 60          # the current month is re-read at most this often
MAX_PAGES = 10             # GitHub caps search at 1,000 results; 10 pages of 100

KINDS = {
    "release": "Release",
    "official": "Official plugin",
    "catalog": "New in catalog",
    "feature": "Feature",
    "plugin-update": "Official plugin update",
}
MAJOR = ("release", "official")       # the kinds worth a desktop notification
# feat(...) scopes that are plumbing, not something a user would call a drop
QUIET_SCOPES = {"ci", "test", "tests", "deps", "build", "chore", "lint", "plugin-catalog", "catalog", "release"}
FEAT_RE = re.compile(r"^feat(?:\(([^)]*)\))?!?:\s*(.+)$", re.I)
PR_REF_RE = re.compile(r"\s*\(#\d+\)\s*$")
# "add X to the plugin catalog" PRs are catalog additions, which the catalog diff already shows
CATALOG_TITLE_RE = re.compile(r"\b(?:plugin[- ]catalog|catalog entry)\b|^(?:add|pin|re-?pin|bump)\b.*\bcatalog\b", re.I)
ADD_RE = re.compile(r"\badd(?:s|ed)?\s+(?:plugin\s+)?[`'\"]?([a-z0-9][a-z0-9._-]{1,60})[`'\"]?", re.I)


def x_file() -> Path | None:
    """The local On-X file, if one is configured or present. Never a URL."""
    raw = os.environ.get("NOUS_CALENDAR_X_FILE", "").strip()
    path = Path(raw).expanduser() if raw else DATA / "x-drops.json"
    return path if path.is_file() else None


class GitHubError(RuntimeError):
    pass


# ── GitHub ──────────────────────────────────────────────────────────────────
def _token() -> str | None:
    return os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or None


_gh_ok: bool | None = None


def auth_mode() -> str:
    """'gh' | 'token' | 'anonymous'. The gh check runs once per process."""
    global _gh_ok
    if _gh_ok is None:
        exe = shutil.which("gh")
        _gh_ok = False
        if exe:
            try:
                _gh_ok = subprocess.run([exe, "auth", "status"], capture_output=True, timeout=15).returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                _gh_ok = False
    if _gh_ok:
        return "gh"
    return "token" if _token() else "anonymous"


def api(path: str, params: dict | None = None):
    """GET one GitHub REST path (no leading slash) and return the decoded JSON."""
    query = urllib.parse.urlencode(params or {})
    full = f"{path}?{query}" if query else path
    if auth_mode() == "gh":
        r = subprocess.run([shutil.which("gh"), "api", "-X", "GET", "-H", "Accept: application/vnd.github+json", full],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            msg = (r.stderr or r.stdout).strip()
            raise GitHubError(msg.splitlines()[-1] if msg else f"gh api {path} failed")
        return json.loads(r.stdout or "null")
    req = urllib.request.Request(f"https://api.github.com/{full}", headers={
        "Accept": "application/vnd.github+json", "User-Agent": f"hermes-nous-calendar/{VERSION}"})
    tok = _token()
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        hint = " (rate limit: sign in with `gh auth login`)" if e.code in (403, 429) else ""
        raise GitHubError(f"GitHub {e.code} on {path}{hint}") from None
    except urllib.error.URLError as e:
        raise GitHubError(f"can't reach GitHub: {e.reason}") from None


def paged(path: str, params: dict, key: str | None = None) -> list:
    out: list = []
    for page in range(1, MAX_PAGES + 1):
        data = api(path, {**params, "per_page": 100, "page": page})
        rows = data.get(key, []) if key else data
        out.extend(rows or [])
        if not rows or len(rows) < 100:
            break
    return out


# ── time ────────────────────────────────────────────────────────────────────
def local_zone_name() -> str | None:
    """This machine's IANA zone name (so the CLI, the agent tool and the page share one cache key)."""
    if os.environ.get("TZ", "").strip(":"):
        return os.environ["TZ"].strip(":")
    try:
        target = os.path.realpath("/etc/localtime")
        if "zoneinfo/" in target:
            return target.split("zoneinfo/", 1)[1]
    except OSError:
        pass
    return None


def zone(name: str | None) -> dt.tzinfo:
    for candidate in (name, local_zone_name()):
        if candidate:
            try:
                return ZoneInfo(candidate)
            except (ZoneInfoNotFoundError, ValueError):
                pass
    return dt.datetime.now().astimezone().tzinfo or dt.timezone.utc


def parse_ts(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso_z(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def month_window(month: str, tz: dt.tzinfo) -> tuple[dt.datetime, dt.datetime]:
    y, m = (int(x) for x in month.split("-"))
    start = dt.datetime(y, m, 1, tzinfo=tz)
    end = dt.datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=tz)
    return start, end


def day_of(t: dt.datetime, tz: dt.tzinfo) -> str:
    return t.astimezone(tz).strftime("%Y-%m-%d")


def next_midnight(t: dt.datetime) -> dt.datetime:
    """The next local midnight after t, safe across daylight-saving changes."""
    d = t.date() + dt.timedelta(days=1)
    return dt.datetime(d.year, d.month, d.day, tzinfo=t.tzinfo)


# ── text ────────────────────────────────────────────────────────────────────
def first_line(text: str, limit: int = 160) -> str:
    """First readable sentence of a release body or description: no headings, links or markdown."""
    for raw in (text or "").splitlines():
        line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", raw)
        line = re.sub(r"[#*`>]+|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])", "", line).strip()
        if len(line) < 12 or line.lower().startswith(("what's changed", "full changelog", "highlights")):
            continue
        line = re.split(r"(?<=[.!?])\s", line, maxsplit=1)[0]
        return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"
    return ""


def short_description(yaml_text: str) -> tuple[str, str]:
    """(tier, one-line description) from a catalog entry; descriptions there can run to pages."""
    try:
        import yaml
        doc = yaml.safe_load(yaml_text) or {}
        desc, tier = str(doc.get("description") or ""), str(doc.get("tier") or "")
    except Exception:
        m = re.search(r"^tier:\s*(\S+)", yaml_text, re.M)
        tier = m.group(1) if m else ""
        m = re.search(r"^description:\s*[>|-]*\s*(.+)$", yaml_text, re.M)
        desc = m.group(1) if m else ""
    desc = desc.split("Disclosure")[0].strip().strip("\"'")
    return tier.strip("\"'").lower(), first_line(desc, 140)


# ── sources ─────────────────────────────────────────────────────────────────
def src_releases(start: dt.datetime, end: dt.datetime) -> list[dict]:
    out = []
    for r in paged(f"repos/{CORE}/releases", {}):
        if r.get("draft") or not r.get("published_at"):
            continue
        t = parse_ts(r["published_at"])
        if start <= t < end:
            name = (r.get("name") or r.get("tag_name") or "").strip()
            out.append({"id": f"release:{r.get('tag_name')}", "kind": "release", "at": iso_z(t), "title": name,
                        "detail": ("Prerelease. " if r.get("prerelease") else "") + first_line(r.get("body") or ""),
                        "url": r.get("html_url"), "repo": CORE})
    return out


def _catalog_names(ref: str, cache: dict) -> list[str]:
    snaps = cache.setdefault("catalog_at", {})
    if ref not in snaps:
        rows = api(f"repos/{CORE}/contents/{CATALOG_DIR}", {"ref": ref})
        snaps[ref] = sorted(r["name"][:-5] for r in rows if isinstance(r, dict) and r.get("name", "").endswith(".yaml"))
    return snaps[ref]


def _catalog_entry(name: str, ref: str, cache: dict) -> tuple[str, str]:
    entries = cache.setdefault("catalog_entry", {})
    key = f"{name}@{ref}"
    if key not in entries:
        try:
            blob = api(f"repos/{CORE}/contents/{CATALOG_DIR}/{name}.yaml", {"ref": ref})
            entries[key] = list(short_description(base64.b64decode(blob.get("content", "")).decode("utf-8", "replace")))
        except GitHubError:
            entries[key] = ["", ""]
    return tuple(entries[key])


def src_catalog(start: dt.datetime, end: dt.datetime, tz: dt.tzinfo, cache: dict, exact: bool) -> list[dict]:
    """Plugins that appeared in plugin-catalog/. Exact mode compares the folder listing at the last
    catalog commit of each day with the day before; otherwise commit messages that say 'add <name>'."""
    commits = paged(f"repos/{CORE}/commits", {"path": CATALOG_DIR, "since": iso_z(start), "until": iso_z(end)})
    if not commits:
        return []
    if not exact:
        out, seen = [], set()
        for c in reversed(commits):
            msg = (c.get("commit", {}).get("message") or "").splitlines()[0]
            m = ADD_RE.search(msg)
            if not m or re.search(r"re-?pin", msg, re.I) or m.group(1).lower() in seen:
                continue
            name = m.group(1).lower()
            seen.add(name)
            kind = "official" if "official" in msg.lower() else "catalog"
            out.append({"id": f"{kind}:{name}", "kind": kind, "at": c["commit"]["committer"]["date"], "title": name,
                        "detail": PR_REF_RE.sub("", msg), "url": c.get("html_url"), "repo": CORE})
        return out
    last_of_day: dict[str, dict] = {}
    for c in commits:  # newest first, so the first one seen per day is that day's last
        last_of_day.setdefault(day_of(parse_ts(c["commit"]["committer"]["date"]), tz), c)
    before = api(f"repos/{CORE}/commits", {"path": CATALOG_DIR, "until": iso_z(start), "per_page": 1})
    prev = set(_catalog_names(before[0]["sha"], cache)) if before else set()
    out = []
    for day in sorted(last_of_day):
        c = last_of_day[day]
        names = set(_catalog_names(c["sha"], cache))
        for name in sorted(names - prev):
            tier, desc = _catalog_entry(name, c["sha"], cache)
            kind = "official" if tier == "official" else "catalog"
            out.append({"id": f"{kind}:{name}", "kind": kind, "at": c["commit"]["committer"]["date"], "title": name,
                        "detail": desc, "url": f"https://github.com/{CORE}/blob/main/{CATALOG_DIR}/{name}.yaml", "repo": CORE})
        prev = names
    return out


def src_features(start: dt.datetime, end: dt.datetime) -> list[dict]:
    q = f"repo:{CORE} is:pr is:merged merged:{iso_z(start)}..{iso_z(end)} feat in:title"
    out = []
    for it in paged("search/issues", {"q": q, "sort": "created", "order": "asc"}, key="items"):
        m = FEAT_RE.match((it.get("title") or "").strip())
        merged = (it.get("pull_request") or {}).get("merged_at") or it.get("closed_at")
        scope = ((m.group(1) if m else "") or "").strip()
        if not m or not merged or scope.lower() in QUIET_SCOPES or CATALOG_TITLE_RE.search(m.group(2)):
            continue
        out.append({"id": f"feature:{it.get('number')}", "kind": "feature", "at": merged, "title": PR_REF_RE.sub("", m.group(2).strip()),
                    "detail": f"{scope} · #{it.get('number')}" if scope else f"#{it.get('number')}", "scope": scope,
                    "url": it.get("html_url"), "repo": CORE})
    return out


def src_plugin_updates(start: dt.datetime, end: dt.datetime) -> list[dict]:
    out = []
    for c in paged(f"repos/{OFFICIAL}/commits", {"since": iso_z(start), "until": iso_z(end)}):
        m = FEAT_RE.match((c.get("commit", {}).get("message") or "").splitlines()[0])
        if not m:
            continue
        scope = (m.group(1) or "").strip()
        out.append({"id": f"plugin-update:{c['sha'][:12]}", "kind": "plugin-update", "at": c["commit"]["committer"]["date"],
                    "title": PR_REF_RE.sub("", m.group(2).strip()), "detail": scope, "scope": scope,
                    "url": c.get("html_url"), "repo": OFFICIAL})
    return out


def merged_counts(start: dt.datetime, end: dt.datetime, tz: dt.tzinfo, now: dt.datetime, cache: dict) -> dict[str, int]:
    """Merged hermes-agent PRs per local day. One search call per day; finished days are kept."""
    store = cache.setdefault("merged", {})
    out, day = {}, start
    while day < end and day <= now:
        nxt = next_midnight(day)
        key = f"{tz}|{day.date()}"
        if key not in store or nxt > now:
            q = f"repo:{CORE} is:pr is:merged merged:{iso_z(day)}..{iso_z(nxt)}"
            store[key] = int(api("search/issues", {"q": q, "per_page": 1}).get("total_count") or 0)
        out[str(day.date())] = store[key]
        day = nxt
    return out


def src_x(month: str) -> dict | None:
    """The day entries of the local On-X file that fall in `month` (its days are in the file's own tz),
    or None when there is no file. A broken file is reported, never fatal."""
    path = x_file()
    if path is None:
        return None
    try:
        feed = json.loads(path.read_text(encoding="utf-8"))
        days = feed["days"]
        if not isinstance(days, dict):
            raise TypeError
    except (OSError, ValueError, KeyError, TypeError):
        return {"error": f"couldn't read {path.name}", "days": {}}
    return {"tz": feed.get("tz") or "America/Los_Angeles", "updated": feed.get("updated"), "big_min": feed.get("bigMin"),
            "days": {d: v for d, v in days.items() if d.startswith(month) and isinstance(v, dict)}}


# ── cache ───────────────────────────────────────────────────────────────────
def load_cache() -> dict:
    try:
        return json.loads(CACHE.read_text())
    except (OSError, ValueError):
        return {}


def save_cache(cache: dict) -> None:
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        tmp.replace(CACHE)
    except OSError:
        pass


# ── collect ─────────────────────────────────────────────────────────────────
def collect(month: str | None = None, tz_name: str | None = None, force: bool = False) -> dict:
    tz = zone(tz_name)
    now = dt.datetime.now(tz)
    month = month or now.strftime("%Y-%m")
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise ValueError("month must look like 2026-10")
    start, end = month_window(month, tz)
    cache = load_cache()
    if tz_name and isinstance(tz, ZoneInfo):
        cache["page_tz"] = tz_name
    key = f"{month}|{tz}"
    hit = cache.get("months", {}).get(key)
    if hit and not force and (end <= now or time.time() - hit.get("generated", 0) < FRESH_S):
        return {**hit, "cached": True, "x": src_x(month)}  # the local X file is re-read every time
    mode = auth_mode()
    window_end = min(end, now + dt.timedelta(minutes=5))
    drops, errors, merged = [], {}, {}
    if start < window_end:
        sources = (("releases", lambda: src_releases(start, window_end)),
                   ("catalog", lambda: src_catalog(start, window_end, tz, cache, exact=mode != "anonymous")),
                   ("features", lambda: src_features(start, window_end)),
                   ("official-plugins", lambda: src_plugin_updates(start, window_end)))
        for name, fn in sources:
            try:
                drops.extend(fn())
            except (GitHubError, KeyError, TypeError, ValueError) as e:
                errors[name] = str(e)[:200]
        if mode != "anonymous":
            try:
                merged = merged_counts(start, window_end, tz, now, cache)
            except GitHubError as e:
                errors["merged"] = str(e)[:200]
    for d in drops:
        d["day"] = day_of(parse_ts(d["at"]), tz)
        d["label"] = KINDS[d["kind"]]
        d["major"] = d["kind"] in MAJOR
    order = {k: i for i, k in enumerate(KINDS)}
    drops.sort(key=lambda d: (d["day"], order[d["kind"]], d["at"]))
    result = {"version": VERSION, "month": month, "tz": str(tz), "today": now.strftime("%Y-%m-%d"),
              "generated": time.time(), "auth": mode, "drops": drops, "merged": merged,
              "counts": {k: sum(1 for d in drops if d["kind"] == k) for k in KINDS},
              "kinds": KINDS, "errors": errors, "cached": False}
    if not errors:  # never cache a partial month
        cache.setdefault("months", {})[key] = result
    save_cache(cache)
    return {**result, "x": src_x(month)}   # attached after caching: the X file stays out of the cache


def compact(data: dict) -> dict:
    """Catalog additions reduced to their names; the page rebuilds the links."""
    slim = [{k: d[k] for k in ("id", "kind", "day", "at", "title", "label", "major")} if d["kind"] == "catalog" else d
            for d in data["drops"]]
    return {**data, "drops": slim}


def summary(period: str = "week", tz_name: str | None = None) -> dict:
    """What the agent tool returns: drops of today / the last 7 days / a month, grouped by day,
    catalog additions as names so a busy day doesn't flood the context."""
    tz = zone(tz_name)
    today = dt.datetime.now(tz).date()
    if re.fullmatch(r"\d{4}-\d{2}", period or ""):
        data, keep = collect(period, tz_name), None
    else:
        days = 1 if period == "today" else 7
        data = collect(None, tz_name)
        if today.day < days:
            older = collect((today.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m"), tz_name)
            data = {**data, "drops": older["drops"] + data["drops"], "merged": {**older["merged"], **data["merged"]}}
        keep = {str(today - dt.timedelta(n)) for n in range(days)}
    out: dict[str, dict] = {}
    for d in data["drops"]:
        if keep is not None and d["day"] not in keep:
            continue
        day = out.setdefault(d["day"], {"merged_prs": data["merged"].get(d["day"])})
        if d["kind"] == "catalog":
            day.setdefault("new_in_catalog", []).append(d["title"])
        else:
            day.setdefault(d["kind"].replace("-", "_") + "s", []).append(
                {"title": d["title"], "detail": d.get("detail") or "", "url": d.get("url") or ""})
    xdays = ((data.get("x") or {}).get("days") or {})
    for day, v in xdays.items():
        if keep is not None and day not in keep:
            continue
        big = v.get("big") or []
        out.setdefault(day, {"merged_prs": data["merged"].get(day)})["on_x"] = {
            "headline": v.get("head"), "types": v.get("types"), "by": v.get("by"), "url": v.get("url"),
            "team_posts": [{"author": t.get("author"), "text": t.get("text"), "url": t.get("url")} for t in (v.get("team") or [])][:6],
            "biggest_posts": [{"author": b.get("author"), "views": b.get("views"), "url": b.get("url")} for b in big[:3]],
        }
    return {"period": period, "time_zone": data["tz"], "today": str(today), "days": dict(sorted(out.items())),
            "x_days_are": ((data.get("x") or {}).get("tz") if xdays else None),
            "source": "public GitHub: NousResearch/hermes-agent and NousResearch/hermes-official-plugins" + ("; On X: a local curated file" if xdays else ""),
            "errors": data.get("errors") or {}}


BG_EVERY_S = 6 * 3600
BG_CLAIM_S = 15 * 60       # a read that started this recently is still running somewhere


def background_refresh() -> bool:
    """Re-read the current month if no read FINISHED in the last 6 hours (any process, any profile that
    shares this cache). A short claim stops parallel processes reading GitHub at once; a read killed
    half-way (Desktop quit, crash) only blocks the next one for 15 minutes, not 6 hours.
    Returns True when it read GitHub. Called by the backend's daily refresher."""
    cache = load_cache()
    now = time.time()
    if now - cache.get("bg_at", 0) < BG_EVERY_S or now - cache.get("bg_claim", 0) < BG_CLAIM_S:
        return False
    cache["bg_claim"] = now
    save_cache(cache)
    tz_name = cache.get("page_tz")
    collect(None, tz_name, force=True)
    today = dt.datetime.now(zone(tz_name)).date()
    if today.day <= 2:         # the first days of a month also settle last month
        collect((today.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m"), tz_name, force=True)
    done = load_cache()        # collect() rewrote the cache; stamp the finished read on the fresh copy
    done["bg_at"] = time.time()
    done.pop("bg_claim", None)
    save_cache(done)
    return True


# ── text output ─────────────────────────────────────────────────────────────
def render(data: dict, days: int | None = None) -> str:
    drops = data["drops"]
    if days is not None:
        today = dt.date.fromisoformat(data["today"])
        keep = {str(today - dt.timedelta(n)) for n in range(days)}
        drops = [d for d in drops if d["day"] in keep]
    span = "today" if days == 1 else f"the last {days} days" if days else data["month"]
    lines = [f"Nous Calendar · {span} ({data['tz']})"]
    if not drops:
        lines.append("  No drops yet.")
    current = None
    for d in drops:
        if d["day"] != current:
            current = d["day"]
            n = data["merged"].get(current)
            lines.append(f"\n{dt.date.fromisoformat(current):%a %b %d}" + (f"  · {n} merged PRs" if n else ""))
        detail = f" — {d['detail']}" if d["detail"] and d["kind"] != "feature" else ""
        lines.append(f"  [{d['label']}] {d['title']}{detail}")
        if d.get("url"):
            lines.append(f"      {d['url']}")
    for k, v in data.get("errors", {}).items():
        lines.append(f"\n  couldn't read {k}: {v}")
    if data.get("auth") == "anonymous":
        lines.append("\n  Not signed in to GitHub: catalog additions come from commit messages. `gh auth login` makes them exact.")
    return "\n".join(lines)


def add_arguments(p: argparse.ArgumentParser) -> None:
    p.add_argument("--month", help="YYYY-MM (default: this month)")
    p.add_argument("--tz", help="IANA time zone for day boundaries (default: this machine's)")
    p.add_argument("--json", action="store_true", help="machine-readable output for the Desktop page")
    p.add_argument("--today", action="store_true", help="only today's drops")
    p.add_argument("--week", action="store_true", help="only the last 7 days")
    p.add_argument("--refresh", action="store_true", help="ignore the 15-minute cache")
    p.add_argument("--compact", action="store_true", help="with --json: catalog additions as names only (fits cli.exec's output cap)")


def dispatch(args) -> str:
    month, tz = getattr(args, "month", None), getattr(args, "tz", None)
    data = collect(month, tz, bool(getattr(args, "refresh", False)))
    if getattr(args, "json", False):
        return json.dumps(compact(data) if getattr(args, "compact", False) else data)
    days = 1 if getattr(args, "today", False) else 7 if getattr(args, "week", False) else None
    if days == 7 and not month and dt.date.fromisoformat(data["today"]).day < 7:
        # the last 7 days reach into last month
        prev = (dt.date.fromisoformat(data["today"]).replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m")
        older = collect(prev, tz)
        data = {**data, "drops": older["drops"] + data["drops"], "merged": {**older["merged"], **data["merged"]}}
    return render(data, days)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="nous-calendar", description=__doc__.split("\n")[0])
    add_arguments(p)
    try:
        print(dispatch(p.parse_args(argv)))
    except ValueError as e:
        print(f"nous-calendar: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
