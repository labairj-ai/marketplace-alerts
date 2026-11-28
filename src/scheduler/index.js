"use strict";
const cron = require("node-cron");
const { getDb } = require("../db");
const { runSingleSearch } = require("../scan");

let _running = false;
let _lastRun  = null;
let _nextRun  = null;
let _task     = null;

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
  const runId = runRow.lastInsertRowid;

  console.log(`[Scheduler] Starting scan (run #${runId}, triggeredBy=${triggeredBy})`);

  let totalResults = 0;
  let totalMatches = 0;
  const errors = [];

  try {
    const searches = db.prepare("SELECT * FROM saved_searches WHERE enabled=1").all();

    for (const search of searches) {
      try {
        const result = await runSingleSearch(db, search, { demo });
        totalResults += result.results;
        totalMatches += result.matches;
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
      runId,
    );
  } catch (err) {
    _lastRun = { at: new Date().toISOString(), ok: false, error: err.message, triggeredBy };
    db.prepare(
      "UPDATE scan_runs SET status=?, error=?, finished_at=datetime('now') WHERE id=?"
    ).run("error", err.message, runId);
    console.error("[Scheduler] Fatal scan error:", err.message);
  } finally {
    _running = false;
  }

  return _lastRun;
}

function start() {
  if (_task) return;
  _task = cron.schedule("*/30 * * * *", async () => {
    _nextRun = computeNextRun();
    await runAllSearches({ triggeredBy: "scheduled" });
    _nextRun = computeNextRun();
  }, { timezone: "America/New_York" });

  _nextRun = computeNextRun();
  console.log("[Scheduler] Started — 30-minute interval, America/New_York");
}

function stop() {
  if (_task) { _task.stop(); _task = null; }
}

function computeNextRun() {
  const now  = new Date();
  const next = new Date(now);
  const mins = now.getMinutes();
  const nextInterval = Math.ceil((mins + 1) / 30) * 30;
  next.setMinutes(nextInterval, 0, 0);
  if (next <= now) next.setMinutes(next.getMinutes() + 30);
  return next.toISOString();
}

process.on("SIGTERM", () => { console.log("[Scheduler] SIGTERM — stopping"); stop(); });

module.exports = { start, stop, runAllSearches, isRunning, getLastRun, getNextRun };
