"""Nous Calendar backend: the Desktop page's own REST namespace, ``/api/plugins/hermes-nous-calendar/``.

Hermes mounts this router when the plugin is in ``plugins.enabled`` and the page reaches it with
``ctx.rest('/month?month=2026-10&tz=America/Los_Angeles')``. Unlike the ``hermes nous-calendar --json``
fallback it has no 48,000-character output cap, which a busy month of catalog additions exceeds.

While the backend is loaded, a daemon thread re-reads the current month from GitHub every 6 hours
(shared across profiles through the cache's own timestamp), so the page, the agent tool and the
notifications are current without anyone opening the page. Public GitHub data only.
"""
from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import re
import sys
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

VERSION = "0.2.1"
router = APIRouter()
log = logging.getLogger("hermes_nous_calendar")


def _cal():
    """nous_calendar.py, loaded by path: the host imports this file on its own, so a package-relative
    import would not resolve."""
    name = "hermes_nous_calendar_script"
    mod = sys.modules.get(name)
    if mod is None:
        path = Path(__file__).resolve().parent.parent / "nous_calendar.py"
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return mod


# ── background refresh ──────────────────────────────────────────────────────
CHECK_EVERY_S = 30 * 60      # wake this often; background_refresh() itself reads GitHub at most every 6 h
_stop = threading.Event()


def _refresher() -> None:
    _stop.wait(60)           # let the gateway finish starting first
    while not _stop.is_set():
        try:
            _cal().background_refresh()
        except Exception as e:  # never take the backend down; try again next round
            log.warning("nous-calendar background refresh failed: %s", e)
        _stop.wait(CHECK_EVERY_S)


def start_refresher() -> threading.Thread | None:
    for t in threading.enumerate():
        if t.name == "hermes-nous-calendar-refresh":
            return None      # already running (module re-imported)
    t = threading.Thread(target=_refresher, name="hermes-nous-calendar-refresh", daemon=True)
    t.start()
    return t


if os.environ.get("NOUS_CALENDAR_NO_BACKGROUND") != "1":   # tests set this
    start_refresher()


# ── routes ──────────────────────────────────────────────────────────────────
@router.get("/health")
async def health():
    return {"ok": True, "version": VERSION}


@router.get("/month")
async def month(month: str | None = Query(default=None), tz: str | None = Query(default=None), refresh: bool = False):
    if month is not None and not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise HTTPException(status_code=400, detail="month must look like 2026-10")
    if tz is not None and not re.fullmatch(r"[A-Za-z0-9_+\-/]{1,64}", tz):
        raise HTTPException(status_code=400, detail="tz must be an IANA zone name like America/Los_Angeles")
    return await asyncio.to_thread(_cal().collect, month, tz, refresh)
