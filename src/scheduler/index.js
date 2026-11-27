"use strict";
const cron = require("node-cron");
const { getDb, upsertListing, upsertMatch } = require("../db");
const { matchListing } = require("../matcher");
const { runSearch } = require("../providers");
const { sendAlertEmail } = require("../notify");

let _running = false;
let _lastRun = null;
let _nextRun = null;
let _task = null;
let _currentRunId = null;

function isRunning() { return _running; }
function getLastRun() { return _lastRun; }
function getNextRun() { return _nextRun; }

async function runAllSearches({ demo = false, triggeredBy = "scheduled" } = {}) {
  if (_running) {
    console.log("[Scheduler] Already running — skipping overlap");
    return { skipped: true, reason: "already_running" };
  }
  _running = true;
  const startedAt = new Date().toISOString();
  const db = getDb();

  const runRow = db.prepare(
    "INSERT INTO scan_runs (status, provider, started_at) VALUES (?, ?, ?)"
  ).run("running", triggeredBy, startedAt);
  _currentRunId = runRow.lastInsertRowid;

  console.log(`[Scheduler] Starting scan (run #${_currentRunId}, triggeredBy=${triggeredBy})`);

  let totalResults = 0;
  let totalMatches = 0;
  const errors = [];

  try {
    const searches = db.prepare("SELECT * FROM saved_searches WHERE enabled=1").all();

    for (const search of searches) {
      try {
        await runSingleSearch(search, { db, demo });
      } catch (err) {
        console.error(`[Scheduler] Error on search "${search.name}":`, err.message);
        errors.push(`${search.name}: ${err.message}`);
      }
    }

    _lastRun = { at: new Date().toISOString(), ok: true, triggeredBy };
    db.prepare(`
      UPDATE scan_runs SET status=?, result_count=?, match_count=?, finished_at=datetime('now'),
        duration_ms=?, error=? WHERE id=?
    `).run(
      "ok", totalResults, totalMatches,
      Date.now() - new Date(startedAt).getTime(),
      errors.length ? errors.join("; ") : null,
      _currentRunId
    );
  } catch (err) {
    _lastRun = { at: new Date().toISOString(), ok: false, error: err.message, triggeredBy };
    db.prepare(`
      UPDATE scan_runs SET status=?, error=?, finished_at=datetime('now') WHERE id=?
    `).run("error", err.message, _currentRunId);
    console.error("[Scheduler] Fatal scan error:", err.message);
  } finally {
    _running = false;
    _currentRunId = null;
  }

  return _lastRun;
}

async function runSingleSearch(search, { db, demo }) {
  const { results, sourceStatuses } = await runSearch(search, { demo });

  if (results.length === 0 && Object.values(sourceStatuses).every(s => s.status !== "LIVE")) {
    // All sources failed — record as error, not empty success
    const errors = Object.entries(sourceStatuses)
      .filter(([, s]) => s.status === "ERROR" || s.status === "AUTHORIZATION_REQUIRED" || s.status === "NOT_CONFIGURED")
      .map(([slug, s]) => `${slug}: ${s.status}`)
      .join("; ");
    console.log(`[Scheduler] Search "${search.name}" — no live source available: ${errors}`);
    return;
  }

  const sourceRows = db.prepare("SELECT id, slug FROM sources").all();
  const sourceMap = Object.fromEntries(sourceRows.map(r => [r.slug, r.id]));

  const newMatches = [];

  for (const item of results) {
    const sourceSlug = item._sourceSlug || "fixture";
    const sourceId = sourceMap[sourceSlug];
    if (!sourceId) continue;

    const listingId = upsertListing(db, sourceId, item);
    const listing = db.prepare("SELECT * FROM listings WHERE id=?").get(listingId);

    const { classification, reasons } = matchListing(listing, search);

    if (classification === "REJECTED") continue;

    const { id: matchId, isNew } = upsertMatch(db, search.id, listingId, classification, reasons);

    if (isNew) {
      const existing = db.prepare(
        "SELECT notified FROM search_matches WHERE id=?"
      ).get(matchId);

      if (!existing?.notified && search.notify_email) {
        // Only email-notify confirmed matches immediately; possible go to dashboard only
        if (classification === "CONFIRMED") {
          newMatches.push({
            classification,
            reasons: JSON.stringify(reasons),
            listing_title: listing.title,
            price: listing.price,
            location_text: listing.location_text,
            listing_url: listing.listing_url,
          });
          db.prepare("UPDATE search_matches SET notified=1, notified_at=datetime('now') WHERE id=?").run(matchId);
        }
      }
    }
  }

  if (newMatches.length > 0) {
    try {
      await sendAlertEmail(search.name, newMatches);
      console.log(`[Scheduler] Sent alert for "${search.name}" — ${newMatches.length} new match(es)`);
    } catch (err) {
      console.error(`[Scheduler] Email error for "${search.name}":`, err.message);
    }
  }

  // Update source status
  for (const [slug, status] of Object.entries(sourceStatuses)) {
    const sourceId = sourceMap[slug];
    if (!sourceId) continue;
    db.prepare(`
      UPDATE sources SET status=?, last_check=datetime('now'), last_error=? WHERE id=?
    `).run(
      status.status,
      status.message || status.error || null,
      sourceId
    );
  }
}

function start() {
  if (_task) return;
  // Every 30 minutes, America/New_York timezone
  _task = cron.schedule("*/30 * * * *", async () => {
    _nextRun = computeNextRun();
    await runAllSearches({ triggeredBy: "scheduled" });
    _nextRun = computeNextRun();
  }, { timezone: "America/New_York" });

  _nextRun = computeNextRun();
  console.log("[Scheduler] Started — 30-minute interval, America/New_York");
}

function stop() {
  if (_task) {
    _task.stop();
    _task = null;
  }
}

function computeNextRun() {
  const now = new Date();
  const next = new Date(now);
  const mins = now.getMinutes();
  const nextInterval = Math.ceil((mins + 1) / 30) * 30;
  next.setMinutes(nextInterval, 0, 0);
  if (next <= now) next.setMinutes(next.getMinutes() + 30);
  return next.toISOString();
}

process.on("SIGTERM", () => {
  console.log("[Scheduler] SIGTERM — stopping");
  stop();
});

module.exports = { start, stop, runAllSearches, isRunning, getLastRun, getNextRun };
