# Marketplace Alerts

A personal saved-search alert tracker for Facebook Marketplace and Craigslist. Runs on the OptiPlex home server and scans every 30 minutes for new listings that match configured searches. Sends email alerts for confirmed matches and surfaces everything through a local web UI.

**Production instance is on the OptiPlex** (`192.168.1.178`). The Mac copy at `~/Desktop/marketplace-alerts/` is dev-only. The authoritative SQLite database lives at `/home/optiplex/marketplace-alerts/data/marketplace.db`.

Live URL: **https://optiplex.tailb97cdb.ts.net:3457/** (Tailscale Funnel, no auth)

---

## Features

- **Multi-source scanning** — Facebook Marketplace (Playwright, logged-in session) and Craigslist (JSON search API, no auth required)
- **Smart matching** — per-search-type matcher rules classify listings as CONFIRMED or REJECTED with labeled reasons; product-specific rules for Mac Studio and QIDI printers
- **Two-tier alt keyword matching** — multi-word alts (e.g. "bounce house") match standalone; single-word alts (e.g. "kids") require co-occurrence with the primary keyword in the title to prevent false positives
- **Geo filtering** — FB results geocoded via Nominatim and hard-filtered at the provider level; CL results filtered by lat/lon at the provider level before they reach the matcher or DB
- **Scheduler pruning + re-evaluation** — after each scheduled scan, stale matches that no longer pass the matcher are purged, and every previously-rejected listing is re-run so new criteria take effect without a manual Scan Now
- **Email alerts** — Gmail SMTP; only fires on new CONFIRMED matches that haven't been seen before
- **Web UI** — Watchlist, Listings table, History, and Status tabs; React via CDN, no build step
- **30-minute scheduler** — node-cron, starts automatically with the systemd service

## Tech Stack

- **Runtime:** Node 22, Express 4
- **Frontend:** React 18 (CDN + Babel standalone, no build step)
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **Browser automation:** Playwright + Chromium (FB Marketplace only)
- **Geocoding:** Nominatim (rate-limited to 2 concurrent requests)
- **Email:** nodemailer (Gmail SMTP)
- **Scheduler:** node-cron

## Project Structure

```
server.js              Express API + static file server
seed.js                DB schema creation + initial data seed
src/
  db/
    index.js           DB helpers (upsertListing, upsertMatch)
  scheduler/
    index.js           30-minute scan loop with post-scan match pruning
  matcher/
    index.js           Keyword + geo matching; two-tier alt logic
    rules/
      mac-studio.js    Apple Mac Studio matcher (RAM, variant detection)
      qidi.js          QIDI 3D printer matcher
  providers/
    index.js           runSearch() — iterates enabled providers
    facebook.js        Playwright-based FB Marketplace scraper + Nominatim geo filter
    craigslist.js      Craigslist JSON API (jsonsearch) + lat/lon geo pre-filter
    fixture.js         Demo/fixture data (PROVIDER_MODE=DEMO)
  geo/
    index.js           Haversine distance + city-center lookup table
    geocoder.js        Nominatim geocoding with file cache + rate limiter
scripts/
  fb-auth-setup.js     One-time FB session capture (run on Mac)
public/
  index.html           Full React UI (single file)
test/                  Node test runner test suite
```

## Setup

### Prerequisites

- Node 22+
- Gmail account with an App Password for SMTP (2FA must be on)
- Facebook account logged in to Chrome (for the one-time auth setup)

### Install

```bash
git clone git@github.com:labairj-ai/marketplace-alerts.git
cd marketplace-alerts
npm install
npx playwright install chromium --with-deps   # FB Marketplace only
```

### Environment

Copy `.env.example` to `.env` and fill in:

```env
PORT=3457
EMAIL_FROM=you@gmail.com
EMAIL_TO=you@gmail.com
EMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx   # Gmail App Password
FB_SESSION_FILE=/path/to/fb_session.json  # optional override
PROVIDER_MODE=                             # set to DEMO for fixture data
```

### Facebook Auth (one-time)

Runs a visible browser on the Mac for manual login, then saves and syncs the session to the OptiPlex:

```bash
node scripts/fb-auth-setup.js
```

Repeat when the session expires (~30–90 days). The session file is gitignored — never commit it.

### Seed the database

```bash
node seed.js
```

Creates the schema and inserts default saved searches (Apple Mac Studio, QIDI Printers Under $200).

### Run locally

```bash
node server.js
# → http://localhost:3457
```

## Deployment (OptiPlex)

The OptiPlex runs the production instance as a systemd service. Deploy flow:

```bash
# On Mac — commit and push
git add -p && git commit -m "..." && git push origin main

# On OptiPlex — pull and restart
ssh optiplex "cd marketplace-alerts && git pull && sudo systemctl restart marketplace-alerts"
```

### Tailscale exposure

The app is served via the main OptiPlex Tailscale instance on port 3457:

```bash
tailscale serve --bg --https=3457 http://localhost:3457
tailscale funnel --bg --https=3457
```

### systemd service

`/etc/systemd/system/marketplace-alerts.service` — enabled, auto-restarts on failure. The `.env` file lives at `/home/optiplex/marketplace-alerts/.env` (not in git).

## Saved Searches

Managed via the Watchlist tab in the UI or directly via the API:

```
POST   /api/searches               create
PUT    /api/searches/:id           update
DELETE /api/searches/:id           delete
POST   /api/searches/:id/check     manual scan + re-evaluation
```

Each search has: `keywords` (primary), `keyword_alts` (see below), `price_min/max`, `center_lat/lon`, `radius_miles`, `specs` (JSON — e.g. `{"minRamGb": 64}`), `notify_email`, `exclude_keywords`.

### Keyword matching

**Primary keywords** (`keywords`): any one must appear in the listing title.

**Alt keywords** (`keyword_alts`): two-tier behavior:
- **Multi-word alts** (2+ words, e.g. `"bounce house"`, `"mini rebounder"`) — match standalone. Use these for complete alternative product names.
- **Single-word alts** (e.g. `"kids"`, `"indoor"`) — qualifier mode. Must co-occur with every significant word of at least one primary keyword in the title. `"kids"` with primary `"trampoline"` only matches titles that contain both — "Kids Trampoline" passes, "Kids Snow Pants" does not.

**Exclusion keywords** (`exclude_keywords`): if any appear in title or description, the listing is rejected regardless of keyword matches.

## Providers

### Facebook Marketplace

Uses Playwright (headless Chromium) with a saved browser session (`fb_session.json`). Searches the Cincinnati marketplace city ID with geolocation context. Each keyword gets its own tab (parallel, `allSettled`). Results are geocoded via Nominatim and hard-filtered against the search radius at the provider level — listings with unknown or out-of-range locations are dropped before they reach the matcher.

### Craigslist

Uses the `jsonsearch` API endpoint (no auth, no Playwright). Searches Cincinnati, Dayton, Lexington, and Columbus markets for each keyword. 3+ word phrases automatically expand to also search the last word (e.g. "Little Tikes Trampoline" also searches "trampoline"). Results are geo-filtered by lat/lon at the provider level before entering the DB. Title-only keyword matching is enforced at match time — description stores the CL query term and is not used for qualification.

## Matching Pipeline

```
Provider fetch → geo pre-filter (provider level) → upsertListing (DB)
  → matchListing:
      1. Product-specific rules (Mac Studio / QIDI) if product_type set
      2. Primary keyword in title
      3. Alt keyword in title (two-tier: standalone multi-word, conjunctive single-word)
      4. Exclusion keywords in title+description
      5. Price range check
      6. Geo distance check
  → upsertMatch or delete from search_matches
```

After each scan, three additional passes run against the DB:

1. **Stale match pruning** — existing matches not in the current scan results are re-evaluated; those that now fail (criteria changed, geo tightened) are removed.
2. **Rejected listing re-evaluation** — every previously-rejected listing in the DB is re-run through the matcher. Any that now qualify (new keywords, improved flex matching) are added as matches and trigger email alerts if CONFIRMED. This is the "standing rule": whenever matching criteria change, the next scheduled scan automatically catches up without requiring a manual Scan Now.

Both passes also run on manual Scan Now, so the UI always reflects the current state of the matcher.

## Email Alerts

Sent via Gmail SMTP when a scan finds a new CONFIRMED match that hasn't been seen before. Configure `EMAIL_FROM`, `EMAIL_TO`, and `EMAIL_APP_PASSWORD` in `.env`.

## Tests

```bash
npm test
# Runs all tests under test/ with Node's built-in test runner
```
