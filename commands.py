"""``hermes nous-calendar`` and ``/nous-calendar``: thin wrappers over nous_calendar.py.

The script is the single source of truth (it also runs standalone), so it is loaded from its
file rather than copied here.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent / "nous_calendar.py"
_NAME = "hermes_nous_calendar_script"


def _cal():
    mod = sys.modules.get(_NAME)
    if mod is None:
        spec = importlib.util.spec_from_file_location(_NAME, _SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[_NAME] = mod
        spec.loader.exec_module(mod)
    return mod


def slash_command(raw_args: str) -> str:
    c = _cal()
    arg = (raw_args or "").strip().lower()
    try:
        if re.fullmatch(r"\d{4}-\d{2}", arg):
            return c.render(c.collect(arg))
        data = c.collect()
        return c.render(data, 1 if arg == "today" else 7)
    except Exception as e:  # a chat reply, never a traceback
        return f"Nous Calendar couldn't read GitHub: {e}"


def setup_argparse(subparser) -> None:
    _cal().add_arguments(subparser)
    subparser.set_defaults(func=handle_cli)
    subs = subparser.add_subparsers(dest="sub")
    a = subs.add_parser("alerts", help="Nous Alerts: new Nous drops on every connected device (no-agent cron, zero tokens)")
    a.add_argument("action", choices=["on", "off", "status", "run"])
    a.add_argument("--dry-run", action="store_true", help="with on: show what would be written and run")
    a.set_defaults(func=handle_cli)


def handle_cli(args) -> None:
    if getattr(args, "sub", None) == "alerts":
        from . import alerts
        act = args.action
        if act == "status":
            print(json.dumps(alerts.status(), indent=2))
            return
        lines = alerts.turn_on(dry_run=bool(getattr(args, "dry_run", False))) if act == "on" else alerts.turn_off() if act == "off" else alerts.run_now()
        print("\n".join(lines))
        return
    try:
        out = _cal().dispatch(args)
        if out:
            print(out)
    except Exception as e:  # the page shows this instead of crashing
        if getattr(args, "json", False):
            sys.stdout.write(json.dumps({"error": f"nous-calendar failed: {type(e).__name__}: {e}"}) + "\n")
        else:
            print(f"nous-calendar failed: {e}")
