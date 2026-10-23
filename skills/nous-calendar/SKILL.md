---
name: nous-calendar
description: Tell the user what Nous Research shipped for Hermes Agent today, this week or in a given month (releases, new official plugins, catalog additions, features), from the nous_calendar tool.
---

# Nous Calendar

Use the `nous_calendar` tool whenever the user asks what's new in Hermes Agent, what Nous shipped or
released, whether a feature or plugin has landed yet, or asks for a Hermes update.

## How to answer

1. Call `nous_calendar` with `period`: `today`, `week` (default) or a month like `2026-10`.
2. Lead with what matters most, in this order: releases, new official plugins, features, official-plugin
   updates, then new catalog plugins.
3. Catalog days can add dozens of plugins. Give the count and name a few that fit what the user does;
   never paste the whole list unless asked.
4. Link each release and feature with the `url` the tool returns. Don't invent links or version numbers.
5. Say "merged on main" for features. A merged feature is not in a release until a release says so.
6. If the tool returns `errors`, say which part couldn't be read (usually GitHub rate limits; `gh auth login`
   fixes them).

## A daily digest, only if the user asks

The Desktop page (Nous Calendar in the sidebar) already updates itself. If the user wants a message every
day on Telegram, Discord or another channel, offer to create a cron job and confirm the time and channel
first, for example:

    hermes cron create --name "Nous drops" --deliver telegram "every day at 08:00" \
      "Use the nous_calendar tool with period today. If nothing major shipped, reply with one short line."

Don't create it without the user's yes.
