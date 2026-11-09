"""Nous Alerts: every new Nous drop on every device connected to Hermes, within 15 minutes, zero model tokens.

How: one no-agent cron job (``nous-alerts``, every 15 min) runs ``$HERMES_HOME/scripts/nous-alerts.sh``, which prints
``nous_calendar.py --alerts`` (only drops newer than the last run, or nothing). Hermes delivers that text to every
connected home channel (``--deliver all``) and sends nothing when it is empty. The first run only records what exists.

This module is the installer: it writes the script into the scripts folder Hermes allows and runs the ``hermes cron``
CLI for create / remove / run / list. It never edits config files or cron storage itself.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent
SCRIPT_NAME = "nous-alerts.sh"
JOB_NAME = "nous-alerts"
SCHEDULE = "every 15m"
TIMEOUT_S = 90


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def scripts_dir() -> Path:
    return hermes_home() / "scripts"


def hermes_bin() -> str:
    return shutil.which("hermes") or str(Path.home() / ".local" / "bin" / "hermes")


def python_bin() -> str:
    return shutil.which("python3") or "python3"


def script_text() -> str:
    return (
        "#!/usr/bin/env bash\n"
        "# Nous Alerts (hermes-nous-calendar): prints new Nous drops since the last run, or nothing.\n"
        "# Installed by `hermes nous-calendar alerts on`; removed by `alerts off`.\n"
        f'exec "{python_bin()}" "{PLUGIN_DIR / "nous_calendar.py"}" --alerts\n'
    )


def _run(args: list[str]) -> tuple[int, str]:
    try:
        r = subprocess.run([hermes_bin(), *args], capture_output=True, text=True, timeout=TIMEOUT_S)
        return r.returncode, (r.stdout + r.stderr).strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, f"could not run hermes {' '.join(args)}: {e}"


def _job() -> dict | None:
    """The job as Hermes stores it, read-only (cron/jobs.json under this profile)."""
    try:
        data = json.loads((hermes_home() / "cron" / "jobs.json").read_text())
    except (OSError, ValueError):
        return None
    jobs = data.get("jobs", data) if isinstance(data, dict) else data
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    for j in jobs or []:
        if isinstance(j, dict) and j.get("name") == JOB_NAME:
            return j
    return None


def status() -> dict:
    job = _job()
    cursor = {}
    try:
        cursor = json.loads((hermes_home() / "plugin-data" / "hermes-nous-calendar" / "alerts-cursor.json").read_text())
    except (OSError, ValueError):
        pass
    return {
        "on": bool(job) and job.get("enabled", True),
        "job": {k: job.get(k) for k in ("name", "schedule", "deliver", "enabled", "last_run", "last_run_at", "last_status")} if job else None,
        "script_installed": (scripts_dir() / SCRIPT_NAME).exists(),
        "script_path": str(scripts_dir() / SCRIPT_NAME),
        "runs": int(cursor.get("runs") or 0),
        "last_checked": cursor.get("last_at") or None,
        "schedule": SCHEDULE,
    }


def turn_on(dry_run: bool = False) -> list[str]:
    lines = []
    path = scripts_dir() / SCRIPT_NAME
    argv = ["cron", "create", SCHEDULE, "--name", JOB_NAME, "--no-agent", "--script", SCRIPT_NAME, "--deliver", "all"]
    if dry_run:
        return [f"would write {path}", f"would run: hermes {' '.join(argv)}"]
    scripts_dir().mkdir(parents=True, exist_ok=True)
    path.write_text(script_text())
    path.chmod(0o755)
    lines.append(f"wrote {path}")
    if _job():
        lines.append(f"cron job '{JOB_NAME}' already exists; left as is")
    else:
        code, out = _run(argv)
        lines.append(f"ran: hermes {' '.join(argv)}")
        if out:
            lines.append(out)
        if code != 0:
            lines.append("cron create failed; alerts are NOT on")
            return lines
    lines.append("Nous Alerts on: new Nous drops go to every connected channel within 15 minutes. "
                 "The first check only records what exists; nothing is sent for old drops.")
    return lines


def turn_off() -> list[str]:
    lines = []
    if _job():
        code, out = _run(["cron", "remove", JOB_NAME])
        lines.append(f"ran: hermes cron remove {JOB_NAME}" + (f": {out}" if out else ""))
    else:
        lines.append(f"no cron job '{JOB_NAME}' found")
    path = scripts_dir() / SCRIPT_NAME
    if path.exists():
        path.unlink()
        lines.append(f"removed {path}")
    lines.append("Nous Alerts off.")
    return lines


def run_now() -> list[str]:
    code, out = _run(["cron", "run", JOB_NAME])
    return [f"ran: hermes cron run {JOB_NAME}"] + ([out] if out else []) + (["(a run with nothing new sends nothing)"] if code == 0 else [])
