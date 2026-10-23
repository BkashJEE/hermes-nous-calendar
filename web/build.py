#!/usr/bin/env python3
"""Build the public web page: web/dist/ with index.html, the plugin's page code and one JSON per month.

    python3 web/build.py [--months 3]

GitHub data plus a public posts feed: each day's biggest X posts (50K+ views) and posts by the Nous team,
taken from the curated file with --posts (default: the local Daily Drops file when it exists), else from the
live site's own posts.json (so a CI build keeps the posts it can't see). Only those posts are published:
no headlines, notes or day labels, and never the maintainer's own posts. "Your Hermes version" is stripped.
Deploy dist/ anywhere static (vercel.json is set up for Vercel).
"""
import argparse
import datetime as dt
import json
import os
import shutil
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent
ROOT = WEB.parent
os.environ["NOUS_CALENDAR_X_FILE"] = str(WEB / "no-x-layer-on-the-web.json")   # never exists: GitHub only
sys.path.insert(0, str(ROOT))
import nous_calendar as n  # noqa: E402


PRIVATE = Path.home() / "Claude/videos/hermes-drops/private/hermes-drops.json"
LIVE = "https://nous-calendar.vercel.app/posts.json"
OWN = {"bkashjosi"}                     # never publish the maintainer's own posts


def public_posts(src: dict) -> dict:
    """Only posts by others: team posts (Nous / Teknium) and the biggest posts, nothing curated."""
    keep = ("author", "time", "url", "text", "views", "likes", "replies", "repost", "quote_of")
    days = {}
    for day, v in sorted((src.get("days") or {}).items()):
        if not isinstance(v, dict):
            continue
        clean = {k: [{f: p[f] for f in keep if f in p} for p in v.get(k) or []
                     if isinstance(p, dict) and str(p.get("author", "")).lower() not in OWN and str(p.get("url", "")).startswith("https://x.com/")]
                 for k in ("team", "big")}
        clean = {k: x for k, x in clean.items() if x}
        if clean:
            days[day] = clean
    return {"version": 1, "kind": "hermes-posts", "tz": src.get("tz") or "America/Los_Angeles", "updated": src.get("updated"),
            "bigMin": src.get("bigMin", 50000), "source": "Public X posts by @NousResearch, @Teknium and the Hermes community; picked by @BkashJosi",
            "days": days}


def enrich(posts: dict) -> dict:
    """Take each post's likes, replies and quoted author live from X's public embed endpoint
    (cdn.syndication.twimg.com, the one embedded tweets use) instead of trusting hand-captured counts.
    Views stay as captured: the endpoint has none. A post the endpoint can't read keeps its values."""
    import re, time, urllib.request
    seen = {}
    for day in posts["days"].values():
        for kind in ("team", "big"):
            for p in day.get(kind, []):
                m = re.search(r"/status/(\d+)", p.get("url", ""))
                if not m:
                    continue
                tid = m.group(1)
                if tid not in seen:
                    try:
                        req = urllib.request.Request(f"https://cdn.syndication.twimg.com/tweet-result?id={tid}&lang=en&token=4", headers={"User-Agent": "Mozilla/5.0"})
                        seen[tid] = json.loads(urllib.request.urlopen(req, timeout=20).read())
                    except Exception:
                        seen[tid] = None
                    time.sleep(0.3)
                r = seen[tid]
                if not r:
                    continue
                if isinstance(r.get("favorite_count"), int):
                    p["likes"] = r["favorite_count"]
                if isinstance(r.get("conversation_count"), int):
                    p["replies"] = r["conversation_count"]
                q = (r.get("quoted_tweet") or {}).get("user", {}).get("screen_name")
                if q:
                    p["quote_of"] = q
                else:
                    p.pop("quote_of", None)
    posts["checked"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return posts


def load_posts(path: str | None) -> dict | None:
    if path or PRIVATE.exists():
        return enrich(public_posts(json.loads(Path(path or PRIVATE).read_text())))
    try:
        import urllib.request
        with urllib.request.urlopen(LIVE, timeout=20) as r:
            return enrich(public_posts(json.loads(r.read().decode())))
    except Exception as e:
        print(f"no posts feed ({e}); building GitHub-only")
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=3, help="this month and the N-1 before it")
    ap.add_argument("--tz", default="America/Los_Angeles")
    ap.add_argument("--posts", help="curated Daily Drops JSON to take public posts from")
    args = ap.parse_args()
    dist = WEB / "dist"
    shutil.rmtree(dist, ignore_errors=True)
    (dist / "data").mkdir(parents=True)
    for f in ("index.html", "sdk-shim.js", "vercel.json"):
        shutil.copy(WEB / f, dist / f)
    shutil.copy(ROOT / "desktop" / "plugin.js", dist / "plugin.js")
    today = dt.datetime.now(n.zone(args.tz)).date().replace(day=1)
    months = []
    for i in range(args.months):
        y, m = today.year, today.month - i
        while m < 1:
            y, m = y - 1, m + 12
        months.append(f"{y}-{m:02d}")
    posts = load_posts(args.posts)
    if posts:
        (dist / "posts.json").write_text(json.dumps(posts, separators=(",", ":")))
        print(f"posts.json: {len(posts['days'])} days")
    for month in months:
        d = n.collect(month, args.tz, force=(month == months[0]))
        d.pop("you", None)
        d["x"] = {"tz": posts["tz"], "updated": posts["updated"], "big_min": posts["bigMin"],
                  "days": {k: v for k, v in posts["days"].items() if k.startswith(month)}} if posts else None
        d["auth"] = "public"
        (dist / "data" / f"{month}.json").write_text(json.dumps(d, separators=(",", ":")))
        print(f"{month}: {sum(d['counts'].values())} drops, errors {d['errors'] or 'none'}")
    (dist / "data" / "index.json").write_text(json.dumps({"months": months, "built": dt.datetime.now(dt.timezone.utc).isoformat()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
