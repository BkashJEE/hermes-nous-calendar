# Changelog

## 0.2.1

- Day cards show the top post's views **and** the merged-PR count ("176K views · 207 PRs").
- Team posts show their likes ("9.6K likes"); counts under 10K keep one decimal.
- A headline that came from GitHub is labelled "Headline", not "On X".

## 0.2.0

- **The biggest posts from X on every day**: posts with 50K+ views and posts by the Nous team, with views and links, from the public feed at nous-calendar.vercel.app/posts.json (`NOUS_CALENDAR_POSTS=off` to skip). The day's corner shows the top post's views.
- **On the web, live**: https://nous-calendar.vercel.app (phones too).

## 0.1.0

First release.

- **Desktop page** `/nous-calendar`: a month grid of releases, new official plugins, feature PRs, official-plugin updates and catalog additions, with the merged-PR count per day. Click a day for every drop and its link.
- **Stays current by itself**: the backend re-reads GitHub every 6 hours; Desktop notifies for new releases and official plugins; a status-bar chip counts new drops.
- **Ask Hermes**: a `nous_calendar` tool and a `nous-calendar` skill.
- **Terminal**: `hermes nous-calendar` (`--week`, `--today`, `--month`) and `/nous-calendar`.
- **The Hermes Daily Drops look**: paper, ink and Hermes blue, Anton dates, a hairline grid, release days in ink, a day sheet with every drop. Fonts bundled (OFL).
- **Optional On-X layer** from a local curated file (`NOUS_CALENDAR_X_FILE`); nothing fetched, nothing shipped.
- Exact catalog additions when signed in to GitHub (the catalog folder compared day by day).
