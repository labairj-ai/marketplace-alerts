# Marketplace Alerts

A personal saved-search alert tracker for Facebook Marketplace and Craigslist. Runs on the OptiPlex home server and scans every 30 minutes for new listings that match configured searches. Sends email alerts for confirmed matches and surfaces everything through a local web UI.

**Production instance is on the OptiPlex** (`192.168.1.178`). The Mac copy at `~/Desktop/marketplace-alerts/` is dev-only. The authoritative SQLite database lives at `/home/optiplex/marketplace-alerts/data/marketplace.db`.

Live URL: **https://optiplex.tailb97cdb.ts.net:3457/** (Tailscale Funnel, no auth)

---

## Features

- **Multi-source scanning** — Facebook Marketplace (Playwright, logged-in session) and Craigslist (JSON search API, no auth required)
- **Smart matching** — per-search-type matcher rules classify listings as CONFIRMED, POSSIBLE, or REJECTED with labeled reasons (RAM, model variant, exclusions)
- **Geo filtering** — FB results filtered to city lookup table within saved search radius; CL results filtered by keyword presence in title
- **Email alerts** — Gmail SMTP; only fires on new CONFIRMED/POSSIBLE matches, not on re-scans of already-seen listings
- **Web UI** — Watchlist, Listings table, History, and Status tabs; React via CDN, no build step
- **30-minute scheduler** — node-cron, starts automatically with the systemd service

## Tech Stack

- **Runtime:** Node 22, Express 4
- **Frontend:** React 18 (CDN + Babel standalone, no build step)
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **Browser automation:** Playwright + Chromium (FB Marketplace only)
- **Email:** nodemailer (Gmail SMTP)
- **Scheduler:** node-cron

## Project Structure

```
server.js              Express API + static file server
seed.js                DB schema creation + initial data seed
src/
  db.js                DB helpers (upsertListing, upsertMatch)
  scheduler.js         30-minute scan loop
  matcher/
    index.js           Routes listings to per-type matcher rules
    rules/
      mac-studio.js    Apple Mac Studio matcher (RAM, variant detection)
      qidi.js          QIDI 3D printer matcher
  providers/
    index.js           runSearch() — iterates enabled providers
    facebook.js        Playwright-based FB Marketplace scraper
    craigslist.js      Craigslist JSON API (jsonsearch endpoint)
    fixture.js         Demo/fixture data (PROVIDER_MODE=DEMO)
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

This creates the schema and inserts the default saved searches (Apple Mac Studio, QIDI Printers Under $200).

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
POST /api/searches          create
PUT  /api/searches/:id      update
DELETE /api/searches/:id    delete
POST /api/searches/:id/check   manual scan
```

Each search has: `keywords` (primary), `keyword_alts` (secondary), `price_min/max`, `center_lat/lon`, `radius_miles`, `specs` (JSON — e.g. `{"minRamGb": 64}`), `notify_email`.

## Providers

### Facebook Marketplace

Uses Playwright (headless Chromium) with a saved browser session (`fb_session.json`). Searches the Cincinnati marketplace city ID with geolocation context. Results are geo-filtered against a city lookup table — only cities within the saved search radius are kept. Ships-to-you / nationwide listings are dropped.

### Craigslist

Uses the `jsonsearch` API endpoint (no auth, no Playwright, no RSS). Searches Cincinnati, Dayton, Lexington, and Columbus markets. Results are filtered to listings whose title contains at least one keyword before the matcher runs.

## Email Alerts

Sent via Gmail SMTP when a scan finds a new CONFIRMED or POSSIBLE match that hasn't been seen before. Configure `EMAIL_FROM`, `EMAIL_TO`, and `EMAIL_APP_PASSWORD` in `.env`.

## Tests

```bash
npm test
# Runs all tests under test/ with Node's built-in test runner
```
