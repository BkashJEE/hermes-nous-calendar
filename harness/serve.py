#!/usr/bin/env python3
"""Serve the page harness: http://127.0.0.1:4734/ opens Nous Calendar with harness/demo.json.

    python3 harness/serve.py [PORT]

demo.json is real, public data, fetched on first run with `nous_calendar.py --json --refresh`
(set NOUS_CALENDAR_DEMO_MONTH=2026-10 for a fixed month). It is not committed.
"""
import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0].rstrip("/") in ("", "/"):
            self.send_response(302)
            self.send_header("Location", "/harness/index.html" + (self.path[1:] if self.path.startswith("/?") else ""))
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, *args):
        pass


def ensure_demo() -> None:
    import os
    import subprocess
    demo = ROOT / "harness" / "demo.json"
    if demo.exists():
        return
    month = os.environ.get("NOUS_CALENDAR_DEMO_MONTH")
    argv = [sys.executable, str(ROOT / "nous_calendar.py"), "--json", "--refresh"] + (["--month", month] if month else [])
    print("Reading GitHub for the demo month (first run only)…", flush=True)
    demo.write_text(subprocess.run(argv, capture_output=True, text=True, check=True).stdout)


if __name__ == "__main__":
    ensure_demo()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4734
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(ROOT))).serve_forever()
