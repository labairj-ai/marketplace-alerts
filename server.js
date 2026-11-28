"use strict";
require("dotenv").config();
const express = require("express");
const path = require("path");
const {
  getDb, upsertListing, upsertMatch,
  setSearchSources, getSearchSourcesMap,
} = require("./src/db");
const { matchListing } = require("./src/matcher");
const { runSearch, getProviders, isDemo } = require("./src/providers");
const { processScanResults } = require("./src/scan");
const { deliverPendingEventsWithRetry, sendTestEmail } = require("./src/notify");
const { scoreListings } = require("./src/scorer");
const { distanceFromSearch } = require("./src/geo");
const scheduler = require("./src/scheduler");

const app = express();
const PORT = process.env.PORT || 3457;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
}));

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
  const totalMatches  = db.prepare("SELECT COUNT(*) as n FROM search_matches").get().n;
  const pendingAlerts = db.prepare("SELECT COUNT(*) as n FROM notification_events WHERE status='pending'").get().n;

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
      running:  scheduler.isRunning(),
      lastRun:  scheduler.getLastRun(),
      nextRun:  scheduler.getNextRun(),
    },
    stats: { totalListings, totalMatches, pendingAlerts },
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
    s.keywords         = safeJson(s.keywords, []);
    s.keyword_alts     = safeJson(s.keyword_alts, []);
    s.exclude_keywords = safeJson(s.exclude_keywords, []);
    s.specs            = safeJson(s.specs, {});
    s.enabled          = !!s.enabled;
    s.notify_email     = !!s.notify_email;
    s.notify_price_drop = !!s.notify_price_drop;
    s.sources          = getSearchSourcesMap(db, s.id);
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
       exclude_keywords, notify_email, notify_price_drop, price_drop_min_dollars, price_drop_min_pct)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.name,
    b.enabled !== false ? 1 : 0,
    JSON.stringify(b.keywords || []),
    JSON.stringify(b.keyword_alts || []),
    b.brand || null,
    b.product_type || null,
    JSON.stringify(b.specs || {}),
    b.price_min ?? null,
    b.price_max ?? null,
    b.center_lat ?? 39.1031,
    b.center_lon ?? -84.5120,
    b.center_label ?? "Cincinnati, OH",
    b.radius_miles ?? 75,
    JSON.stringify(b.exclude_keywords || []),
    b.notify_email !== false ? 1 : 0,
    b.notify_price_drop ? 1 : 0,
    b.price_drop_min_dollars ?? null,
    b.price_drop_min_pct ?? null,
  );

  const newId = r.lastInsertRowid;

  // Set per-search sources (defaults to both enabled if not specified)
  const sourcesMap = b.sources || { facebook_marketplace: true, craigslist: true };
  setSearchSources(db, newId, Object.keys(sourcesMap).filter(k => sourcesMap[k]));

  res.status(201).json({ id: newId });
});

app.put("/api/searches/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM saved_searches WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const b = req.body;

  // ── Price field semantics ──────────────────────────────────────────────────
  // Field omitted (undefined) → retain existing value
  // Field set to null         → clear the constraint
  // Field set to a number     → update
  // Invalid numeric           → 400
  let priceMin = existing.price_min;
  let priceMax = existing.price_max;

  if ("price_min" in b) {
    if (b.price_min === null) {
      priceMin = null;
    } else {
      const v = Number(b.price_min);
      if (isNaN(v)) return res.status(400).json({ error: "price_min must be a number or null" });
      priceMin = v;
    }
  }

  if ("price_max" in b) {
    if (b.price_max === null) {
      priceMax = null;
    } else {
      const v = Number(b.price_max);
      if (isNaN(v)) return res.status(400).json({ error: "price_max must be a number or null" });
      priceMax = v;
    }
  }

  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    return res.status(400).json({ error: "price_min cannot be greater than price_max" });
  }

  // product_type: if explicitly provided in the request body, use it; otherwise retain existing.
  // Do NOT infer from keywords — the user's explicit choice takes precedence.
  const productType = "product_type" in b ? (b.product_type || null) : existing.product_type;

  db.prepare(`
    UPDATE saved_searches SET
      name=?, enabled=?, keywords=?, keyword_alts=?, brand=?, product_type=?, specs=?,
      price_min=?, price_max=?, center_lat=?, center_lon=?, center_label=?,
      radius_miles=?, exclude_keywords=?, notify_email=?,
      notify_price_drop=?, price_drop_min_dollars=?, price_drop_min_pct=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    b.name ?? existing.name,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : existing.enabled,
    JSON.stringify(b.keywords  ?? safeJson(existing.keywords, [])),
    JSON.stringify(b.keyword_alts ?? safeJson(existing.keyword_alts, [])),
    b.brand ?? existing.brand,
    productType,
    JSON.stringify(b.specs ?? safeJson(existing.specs, {})),
    priceMin,
    priceMax,
    b.center_lat ?? existing.center_lat,
    b.center_lon ?? existing.center_lon,
    b.center_label ?? existing.center_label,
    b.radius_miles ?? existing.radius_miles,
    JSON.stringify(b.exclude_keywords ?? safeJson(existing.exclude_keywords, [])),
    b.notify_email !== undefined ? (b.notify_email ? 1 : 0) : existing.notify_email,
    b.notify_price_drop !== undefined ? (b.notify_price_drop ? 1 : 0) : (existing.notify_price_drop ?? 0),
    "price_drop_min_dollars" in b ? (b.price_drop_min_dollars ?? null) : (existing.price_drop_min_dollars ?? null),
    "price_drop_min_pct"     in b ? (b.price_drop_min_pct     ?? null) : (existing.price_drop_min_pct     ?? null),
    id,
  );

  if ("sources" in b && b.sources && typeof b.sources === "object") {
    const enabled = Object.keys(b.sources).filter(k => b.sources[k]);
    setSearchSources(db, id, enabled);
  }

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
    const { results, matches, totalMatches, sourceStatuses } = await require("./src/scan").runSingleSearch(db, search, { demo });

    res.json({ ok: true, sourceStatuses, results, matches, totalMatches, demo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Test Email ───────────────────────────────────────────────────────────────

app.post("/api/email/test", async (req, res) => {
  try {
    await sendTestEmail();
    res.json({ ok: true });
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

  if (search_id)      { sql += " AND sm.search_id=?";       params.push(Number(search_id)); }
  if (classification) { sql += " AND sm.classification=?";  params.push(classification); }
  if (source)         { sql += " AND s.slug=?";             params.push(source); }

  // Fetch all first (needed for relative price scoring), then sort
  const orderMap = {
    newest:      "sm.first_matched DESC",
    listed_desc: "COALESCE(l.listed_at, l.discovered_at) DESC",
    listed_asc:  "COALESCE(l.listed_at, l.discovered_at) ASC",
    price_asc:   "l.price ASC",
    price_desc:  "l.price DESC",
    distance:    "l.id ASC",
  };

  const fetchSql = sql + ` ORDER BY ${orderMap[sort] || orderMap.newest}`;
  let rows = db.prepare(fetchSql).all(...params);

  for (const r of rows) {
    r.reasons = safeJson(r.reasons, []);
  }

  // Compute scores when searching within a specific saved search
  if (search_id) {
    const search = db.prepare("SELECT * FROM saved_searches WHERE id=?").get(Number(search_id));
    if (search) {
      // Augment rows with distance info for scorer
      const augmented = rows.map(r => ({
        ...r,
        price: r.price,
        latitude: r.latitude,
        longitude: r.longitude,
        listed_at: r.listed_at,
        discovered_at: r.discovered_at,
      }));
      const scored = scoreListings(augmented, search);
      rows = scored;

      if (sort === "best_fit") {
        rows = [...rows].sort((a, b) => (b.score || 0) - (a.score || 0));
      }
    }
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
      l.image_url, l.discovered_at, l.listed_at, s.name as source_name, s.slug as source_slug,
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
  res.json(db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 50").all());
});

// ─── Sources ──────────────────────────────────────────────────────────────────

app.get("/api/sources", (req, res) => {
  const db = getDb();
  res.json(db.prepare("SELECT * FROM sources").all());
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────

app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
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
