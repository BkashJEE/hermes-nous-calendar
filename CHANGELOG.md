# Changelog

## 0.1.0

First release.

- **Desktop page** `/nous-calendar`: a month grid of releases, new official plugins, feature PRs, official-plugin updates and catalog additions, with the merged-PR count per day. Click a day for every drop and its link.
- **Stays current by itself**: the backend re-reads GitHub every 6 hours; Desktop notifies for new releases and official plugins; a status-bar chip counts new drops.
- **Ask Hermes**: a `nous_calendar` tool and a `nous-calendar` skill.
- **Terminal**: `hermes nous-calendar` (`--week`, `--today`, `--month`) and `/nous-calendar`.
- **The Hermes Daily Drops look**: paper, ink and Hermes blue, Anton dates, a hairline grid, release days in ink, a day sheet with every drop. Fonts bundled (OFL).
- **Optional On-X layer** from a local curated file (`NOUS_CALENDAR_X_FILE`); nothing fetched, nothing shipped.
- Exact catalog additions when signed in to GitHub (the catalog folder compared day by day).
