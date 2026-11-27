"use strict";
require("dotenv").config();
const express = require("express");
const path = require("path");
const { getDb, upsertListing, upsertMatch } = require("./src/db");
const { matchListing } = require("./src/matcher");
const { runSearch, getProviders, isDemo } = require("./src/providers");
const scheduler = require("./src/scheduler");

const app = express();
const PORT = process.env.PORT || 3457;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "marketplace-alerts", uptime: process.uptime() });
});

// ─── Status ──────────────────────────────────────────────────────────────────

app.get("/api/status", async (req, res) => {
  const db = getDb();
  const providers = getProviders();
  const sources = db.prepare("SELECT * FROM sources").all();
  const lastScan = db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get();
  const totalListings = db.prepare("SELECT COUNT(*) as n FROM listings").get().n;
  const totalMatches = db.prepare("SELECT COUNT(*) as n FROM search_matches").get().n;

  const sourceStatuses = {};
  for (const source of sources) {
    const provider = providers[source.slug];
    sourceStatuses[source.slug] = {
      name: source.name,
      status: source.status,
      lastCheck: source.last_check,
      lastError: source.last_error,
      ...(provider ? await provider.getStatus().catch(e => ({ error: e.message })) : {}),
    };
  }

  res.json({
    ok: true,
    demo: isDemo(),
    sources: sourceStatuses,
    scheduler: {
      running: scheduler.isRunning(),
      lastRun: scheduler.getLastRun(),
      nextRun: scheduler.getNextRun(),
    },
    stats: { totalListings, totalMatches },
    lastScan: lastScan || null,
  });
});

// ─── Saved Searches CRUD ─────────────────────────────────────────────────────

app.get("/api/searches", (req, res) => {
  const db = getDb();
  const searches = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM search_matches sm WHERE sm.search_id=s.id) AS match_count,
      (SELECT MAX(sr.started_at) FROM scan_runs sr WHERE sr.search_id=s.id) AS last_checked
    FROM saved_searches s ORDER BY s.id
  `).all();

  for (const s of searches) {
    s.keywords = safeJson(s.keywords, []);
    s.keyword_alts = safeJson(s.keyword_alts, []);
    s.exclude_keywords = safeJson(s.exclude_keywords, []);
    s.specs = safeJson(s.specs, {});
    s.enabled = !!s.enabled;
    s.notify_email = !!s.notify_email;
  }

  res.json(searches);
});

app.post("/api/searches", (req, res) => {
  const db = getDb();
  const b = req.body;
  if (!b.name || !b.keywords?.length) {
    return res.status(400).json({ error: "name and keywords are required" });
  }
  const r = db.prepare(`
    INSERT INTO saved_searches
      (name, enabled, keywords, keyword_alts, brand, product_type, specs,
       price_min, price_max, center_lat, center_lon, center_label, radius_miles,
       exclude_keywords, notify_email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.name, b.enabled !== false ? 1 : 0,
    JSON.stringify(b.keywords || []),
    JSON.stringify(b.keyword_alts || []),
    b.brand || null, b.product_type || null,
    JSON.stringify(b.specs || {}),
    b.price_min ?? null, b.price_max ?? null,
    b.center_lat ?? 39.1031, b.center_lon ?? -84.5120,
    b.center_label ?? "Cincinnati, OH",
    b.radius_miles ?? 75,
    JSON.stringify(b.exclude_keywords || []),
    b.notify_email !== false ? 1 : 0
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put("/api/searches/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM saved_searches WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const b = req.body;

  db.prepare(`
    UPDATE saved_searches SET
      name=?, enabled=?, keywords=?, keyword_alts=?, brand=?, product_type=?, specs=?,
      price_min=?, price_max=?, center_lat=?, center_lon=?, center_label=?,
      radius_miles=?, exclude_keywords=?, notify_email=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    b.name ?? existing.name,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : existing.enabled,
    JSON.stringify(b.keywords ?? safeJson(existing.keywords, [])),
    JSON.stringify(b.keyword_alts ?? safeJson(existing.keyword_alts, [])),
    b.brand ?? existing.brand, b.product_type ?? existing.product_type,
    JSON.stringify(b.specs ?? safeJson(existing.specs, {})),
    b.price_min ?? existing.price_min, b.price_max ?? existing.price_max,
    b.center_lat ?? existing.center_lat, b.center_lon ?? existing.center_lon,
    b.center_label ?? existing.center_label,
    b.radius_miles ?? existing.radius_miles,
    JSON.stringify(b.exclude_keywords ?? safeJson(existing.exclude_keywords, [])),
    b.notify_email !== undefined ? (b.notify_email ? 1 : 0) : existing.notify_email,
    id
  );
  res.json({ ok: true });
});

app.delete("/api/searches/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!db.prepare("SELECT id FROM saved_searches WHERE id=?").get(id)) {
    return res.status(404).json({ error: "not found" });
  }
  db.prepare("DELETE FROM saved_searches WHERE id=?").run(id);
  res.json({ ok: true });
});

// ─── Manual check ─────────────────────────────────────────────────────────────

app.post("/api/searches/:id/check", async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const search = db.prepare("SELECT * FROM saved_searches WHERE id=?").get(id);
  if (!search) return res.status(404).json({ error: "not found" });

  if (scheduler.isRunning()) {
    return res.status(409).json({ error: "A scan is already running. Try again shortly." });
  }

  const demo = req.query.demo === "true" || isDemo();

  try {
    const { results, sourceStatuses } = await runSearch(search, { demo });

    const sourceRows = db.prepare("SELECT id, slug FROM sources").all();
    const sourceMap = Object.fromEntries(sourceRows.map(r => [r.slug, r.id]));

    const matches = [];
    for (const item of results) {
      const sourceId = sourceMap[item._sourceSlug || "fixture"];
      if (!sourceId) continue;
      const listingId = upsertListing(db, sourceId, item);
      const listing = db.prepare("SELECT * FROM listings WHERE id=?").get(listingId);
      const matchResult = matchListing(listing, search);
      if (matchResult.classification !== "REJECTED") {
        upsertMatch(db, search.id, listingId, matchResult.classification, matchResult.reasons);
        matches.push({ ...matchResult, listing });
      }
    }

    res.json({ ok: true, sourceStatuses, results: results.length, matches: matches.length, demo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Listings ─────────────────────────────────────────────────────────────────

app.get("/api/listings", (req, res) => {
  const db = getDb();
  const { search_id, classification, source, sort = "newest" } = req.query;

  let sql = `
    SELECT l.*, s.slug as source_slug, s.name as source_name,
      sm.classification, sm.reasons, sm.first_matched, sm.last_matched,
      sm.search_id, ss.name as search_name
    FROM listings l
    JOIN sources s ON s.id=l.source_id
    JOIN search_matches sm ON sm.listing_id=l.id
    JOIN saved_searches ss ON ss.id=sm.search_id
    WHERE 1=1
  `;
  const params = [];

  if (search_id) { sql += " AND sm.search_id=?"; params.push(Number(search_id)); }
  if (classification) { sql += " AND sm.classification=?"; params.push(classification); }
  if (source) { sql += " AND s.slug=?"; params.push(source); }

  const orderMap = {
    newest: "sm.first_matched DESC",
    price_asc: "l.price ASC",
    price_desc: "l.price DESC",
    distance: "l.id ASC",
  };
  sql += ` ORDER BY ${orderMap[sort] || orderMap.newest}`;

  const rows = db.prepare(sql).all(...params);
  for (const r of rows) {
    r.reasons = safeJson(r.reasons, []);
  }
  res.json(rows);
});

app.get("/api/listings/:id", (req, res) => {
  const db = getDb();
  const listing = db.prepare(`
    SELECT l.*, s.slug as source_slug, s.name as source_name
    FROM listings l JOIN sources s ON s.id=l.source_id WHERE l.id=?
  `).get(Number(req.params.id));
  if (!listing) return res.status(404).json({ error: "not found" });

  const history = db.prepare(
    "SELECT price, observed_at FROM price_history WHERE listing_id=? ORDER BY observed_at"
  ).all(Number(req.params.id));

  const matches = db.prepare(`
    SELECT sm.*, ss.name as search_name FROM search_matches sm
    JOIN saved_searches ss ON ss.id=sm.search_id WHERE sm.listing_id=?
  `).all(Number(req.params.id));

  res.json({ ...listing, priceHistory: history, matches });
});

// ─── Alert History ─────────────────────────────────────────────────────────────

app.get("/api/alerts/history", (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT sm.*, l.title as listing_title, l.price, l.location_text, l.listing_url,
      l.image_url, l.discovered_at, s.name as source_name, s.slug as source_slug,
      ss.name as search_name
    FROM search_matches sm
    JOIN listings l ON l.id=sm.listing_id
    JOIN sources s ON s.id=l.source_id
    JOIN saved_searches ss ON ss.id=sm.search_id
    ORDER BY sm.first_matched DESC LIMIT 200
  `).all();
  for (const r of rows) r.reasons = safeJson(r.reasons, []);
  res.json(rows);
});

// ─── Scan Runs ─────────────────────────────────────────────────────────────────

app.get("/api/scans", (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM scan_runs ORDER BY id DESC LIMIT 50"
  ).all();
  res.json(rows);
});

// ─── Sources ──────────────────────────────────────────────────────────────────

app.get("/api/sources", (req, res) => {
  const db = getDb();
  res.json(db.prepare("SELECT * FROM sources").all());
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

function safeJson(val, def) {
  if (!val) return def;
  try { return JSON.parse(val); } catch { return def; }
}

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`\nMarketplace Alerts → http://localhost:${PORT}\n`);
    scheduler.start();
  });
}

module.exports = app;
