"""hermes-nous-calendar: what Nous Research shipped for Hermes Agent, day by day.

Registers:
  * ``nous_calendar`` tool so Hermes can answer "what did Nous ship today / this week?" in any chat;
  * ``nous-calendar`` skill: when to use the tool, and how to set up a daily digest if asked;
  * ``hermes nous-calendar`` CLI command (``--json`` for the desktop page, ``--week`` / ``--today``);
  * ``/nous-calendar`` slash command with the last 7 days as text.

The desktop page in ``desktop/plugin.js`` reads the plugin's own backend (``dashboard/plugin_api.py``),
which also re-reads GitHub in the background every 6 hours so the page is current when opened.
Everything is read from public GitHub data; nothing is written outside the plugin's cache.
"""

from __future__ import annotations

import json
from pathlib import Path

from . import commands

TOOL_SCHEMA = {
    "name": "nous_calendar",
    "description": (
        "What Nous Research shipped for Hermes Agent, by day: releases, new official plugins, plugins new in "
        "the plugin catalog, merged feature PRs and official-plugin updates, plus how many PRs merged each day. "
        "Use it when the user asks what's new in Hermes, what Nous shipped or released, whether a feature or "
        "plugin has landed, or wants a daily/weekly Hermes update. Reads public GitHub; no account needed."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "period": {
                "type": "string",
                "description": "'today', 'week' (the last 7 days, default) or a month as YYYY-MM.",
            },
        },
        "additionalProperties": False,
    },
}


def _tool(args: dict, **_kw) -> str:
    period = str((args or {}).get("period") or "week").strip().lower()
    try:
        return json.dumps(commands._cal().summary(period), ensure_ascii=False)
    except Exception as e:  # the agent gets a reason, never a traceback
        return json.dumps({"error": f"nous_calendar couldn't read GitHub: {e}"})


def register(ctx) -> None:
    ctx.register_tool(name="nous_calendar", toolset="nous_calendar", schema=TOOL_SCHEMA, handler=_tool,
                      description="What Nous shipped for Hermes Agent, by day", emoji="☤")
    skill = Path(__file__).resolve().parent / "skills" / "nous-calendar" / "SKILL.md"
    if hasattr(ctx, "register_skill") and skill.exists():
        ctx.register_skill("nous-calendar", skill, description="Tell the user what Nous shipped for Hermes Agent today, this week or in a month")
    ctx.register_command(
        "nous-calendar",
        handler=commands.slash_command,
        description="What Nous shipped for Hermes Agent in the last 7 days (hermes-nous-calendar)",
        args_hint="[today|week|YYYY-MM]",
    )
    ctx.register_cli_command(
        name="nous-calendar",
        help="What Nous shipped for Hermes Agent, day by day: releases, official plugins, catalog, features",
        setup_fn=commands.setup_argparse,
        handler_fn=commands.handle_cli,
    )
