#!/usr/bin/env python3
"""Build the public web page: web/dist/ with index.html, the plugin's page code and one JSON per month.

    python3 web/build.py [--months 3]

Public GitHub data only. The On-X layer and "your Hermes version" are stripped, whatever this machine has.
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=3, help="this month and the N-1 before it")
    ap.add_argument("--tz", default="America/Los_Angeles")
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
    for month in months:
        d = n.collect(month, args.tz, force=(month == months[0]))
        d.pop("x", None)
        d.pop("you", None)
        d["auth"] = "public"
        (dist / "data" / f"{month}.json").write_text(json.dumps(d, separators=(",", ":")))
        print(f"{month}: {sum(d['counts'].values())} drops, errors {d['errors'] or 'none'}")
    (dist / "data" / "index.json").write_text(json.dumps({"months": months, "built": dt.datetime.now(dt.timezone.utc).isoformat()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
