"use strict";
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

let _db = null;

function getDb() {
  if (_db) return _db;
  const dbPath = process.env.DB_PATH || path.join(__dirname, "../../data/marketplace.db");
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function addColumnIfMissing(db, table, column, typeDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
  } catch (e) {
    if (!e.message.includes("duplicate column name")) throw e;
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
      last_check  TEXT,
      last_error  TEXT,
      metadata    TEXT
    );

    CREATE TABLE IF NOT EXISTS saved_searches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      keywords        TEXT NOT NULL,
      keyword_alts    TEXT,
      brand           TEXT,
      product_type    TEXT,
      specs           TEXT,
      price_min       REAL,
      price_max       REAL,
      center_lat      REAL NOT NULL DEFAULT 39.1031,
      center_lon      REAL NOT NULL DEFAULT -84.5120,
      center_label    TEXT NOT NULL DEFAULT 'Cincinnati, OH',
      radius_miles    REAL NOT NULL DEFAULT 75,
      exclude_keywords TEXT,
      notify_email    INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS search_sources (
      search_id   INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
      source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      enabled     INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (search_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS listings (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id         INTEGER NOT NULL REFERENCES sources(id),
      external_id       TEXT NOT NULL,
      title             TEXT NOT NULL,
      description       TEXT,
      price             REAL,
      currency          TEXT DEFAULT 'USD',
      location_text     TEXT,
      latitude          REAL,
      longitude         REAL,
      image_url         TEXT,
      listing_url       TEXT,
      listed_at         TEXT,
      discovered_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
      raw               TEXT,
      UNIQUE(source_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS search_matches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id       INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
      listing_id      INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      classification  TEXT NOT NULL,
      reasons         TEXT NOT NULL,
      notified        INTEGER NOT NULL DEFAULT 0,
      notified_at     TEXT,
      first_matched   TEXT NOT NULL DEFAULT (datetime('now')),
      last_matched    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(search_id, listing_id)
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      price       REAL NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   INTEGER REFERENCES sources(id),
      search_id   INTEGER REFERENCES saved_searches(id),
      status      TEXT NOT NULL,
      provider    TEXT,
      result_count INTEGER DEFAULT 0,
      match_count  INTEGER DEFAULT 0,
      error       TEXT,
      duration_ms INTEGER,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id       INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
      listing_id      INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      event_type      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      classification  TEXT,
      reasons         TEXT,
      price_before    REAL,
      price_after     REAL,
      error           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at    TEXT
    );
  `);

  // Partial unique index — prevents duplicate pending events per (search, listing, type)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_event
    ON notification_events(search_id, listing_id, event_type)
    WHERE status = 'pending';
  `);

  // Additive column migrations (safe to re-run)
  addColumnIfMissing(db, "saved_searches", "notify_price_drop",      "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "saved_searches", "price_drop_min_dollars", "REAL");
  addColumnIfMissing(db, "saved_searches", "price_drop_min_pct",     "REAL");
  addColumnIfMissing(db, "search_matches", "price_drop_ref",         "REAL");

  seedSources(db);
  backfillSearchSources(db);
}

function seedSources(db) {
  const upsert = db.prepare(`
    INSERT INTO sources (slug, name, status) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO NOTHING
  `);
  upsert.run("facebook_marketplace", "Facebook Marketplace", "AUTHORIZATION_REQUIRED");
  upsert.run("craigslist", "Craigslist", "NOT_CONFIGURED");
  upsert.run("fixture", "Demo (Fixture)", "NOT_CONFIGURED");
}

// Ensure every existing saved search has entries in search_sources for both
// live sources. Idempotent — INSERT OR IGNORE skips existing rows.
function backfillSearchSources(db) {
  const searches = db.prepare("SELECT id FROM saved_searches").all();
  const fbId  = db.prepare("SELECT id FROM sources WHERE slug='facebook_marketplace'").get()?.id;
  const clId  = db.prepare("SELECT id FROM sources WHERE slug='craigslist'").get()?.id;
  if (!fbId || !clId) return;

  const ins = db.prepare(
    "INSERT OR IGNORE INTO search_sources (search_id, source_id, enabled) VALUES (?, ?, 1)"
  );
  const tx = db.transaction(() => {
    for (const { id } of searches) {
      ins.run(id, fbId);
      ins.run(id, clId);
    }
  });
  tx();
}

// ─── Listing / match helpers ──────────────────────────────────────────────────

function upsertListing(db, sourceId, item) {
  const existing = db.prepare(
    "SELECT id, price FROM listings WHERE source_id=? AND external_id=?"
  ).get(sourceId, item.listingId);

  if (existing) {
    if (item.price !== null && item.price !== undefined && existing.price !== item.price) {
      db.prepare(
        "INSERT INTO price_history (listing_id, price) VALUES (?, ?)"
      ).run(existing.id, item.price);
    }
    db.prepare(`
      UPDATE listings SET title=?, description=?, price=?, location_text=?,
        latitude=?, longitude=?, image_url=?, listing_url=?, last_seen_at=datetime('now'), raw=?
      WHERE id=?
    `).run(
      item.title, item.description || null, item.price, item.locationText || null,
      item.latitude || null, item.longitude || null, item.imageUrl || null,
      item.listingUrl || null, JSON.stringify(item.raw || {}), existing.id
    );
    return existing.id;
  }

  const r = db.prepare(`
    INSERT INTO listings
      (source_id, external_id, title, description, price, currency, location_text,
       latitude, longitude, image_url, listing_url, listed_at, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceId, item.listingId, item.title, item.description || null,
    item.price, item.currency || "USD", item.locationText || null,
    item.latitude || null, item.longitude || null,
    item.imageUrl || null, item.listingUrl || null,
    item.listedAt || null, JSON.stringify(item.raw || {})
  );

  if (item.price !== null && item.price !== undefined) {
    db.prepare("INSERT INTO price_history (listing_id, price) VALUES (?, ?)").run(r.lastInsertRowid, item.price);
  }

  return r.lastInsertRowid;
}

function upsertMatch(db, searchId, listingId, classification, reasons) {
  const existing = db.prepare(
    "SELECT id, classification FROM search_matches WHERE search_id=? AND listing_id=?"
  ).get(searchId, listingId);

  if (existing) {
    db.prepare(`
      UPDATE search_matches SET classification=?, reasons=?, last_matched=datetime('now')
      WHERE id=?
    `).run(classification, JSON.stringify(reasons), existing.id);
    return { id: existing.id, isNew: false, prevClassification: existing.classification };
  }

  const r = db.prepare(`
    INSERT INTO search_matches (search_id, listing_id, classification, reasons)
    VALUES (?, ?, ?, ?)
  `).run(searchId, listingId, classification, JSON.stringify(reasons));
  return { id: r.lastInsertRowid, isNew: true, prevClassification: null };
}

// ─── Notification event helpers ───────────────────────────────────────────────

// Creates or updates a pending notification event. The partial unique index on
// (search_id, listing_id, event_type) WHERE status='pending' means only one
// pending event per type per listing per search can exist at a time.
function createNotificationEvent(db, { search_id, listing_id, event_type, classification, reasons, price_before, price_after }) {
  const existing = db.prepare(
    "SELECT id FROM notification_events WHERE search_id=? AND listing_id=? AND event_type=? AND status='pending'"
  ).get(search_id, listing_id, event_type);

  if (existing) {
    // Update the pending event with latest data (e.g. price dropped further, classification upgraded)
    db.prepare(`
      UPDATE notification_events
      SET classification=COALESCE(?,classification),
          price_after=COALESCE(?,price_after)
      WHERE id=?
    `).run(classification || null, price_after ?? null, existing.id);
    return existing.id;
  }

  const r = db.prepare(`
    INSERT INTO notification_events
      (search_id, listing_id, event_type, classification, reasons, price_before, price_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(search_id, listing_id, event_type,
    classification || null, reasons || null,
    price_before ?? null, price_after ?? null);
  return r.lastInsertRowid;
}

function getPendingEvents(db, searchId) {
  return db.prepare(`
    SELECT ne.*, l.title as listing_title, l.price as current_price,
      l.location_text, l.listing_url, l.image_url,
      s.slug as source_slug, s.name as source_name,
      sm.price_drop_ref
    FROM notification_events ne
    JOIN listings l ON l.id = ne.listing_id
    JOIN sources s ON s.id = l.source_id
    LEFT JOIN search_matches sm
      ON sm.search_id=ne.search_id AND sm.listing_id=ne.listing_id
    WHERE ne.search_id=? AND ne.status='pending'
    ORDER BY ne.event_type DESC, ne.created_at
  `).all(searchId);
}

function markEventsDelivered(db, eventIds, matchListingIds) {
  if (!eventIds.length) return;
  const ph = eventIds.map(() => "?").join(",");
  db.prepare(`
    UPDATE notification_events
    SET status='delivered', delivered_at=datetime('now'), error=NULL
    WHERE id IN (${ph})
  `).run(...eventIds);

  // Mark search_matches as notified for the included listing IDs
  if (matchListingIds && matchListingIds.length) {
    // bulk update via loop — search_id is per-event but all events share the same search
    for (const { searchId, listingId } of matchListingIds) {
      db.prepare(`
        UPDATE search_matches SET notified=1, notified_at=datetime('now')
        WHERE search_id=? AND listing_id=? AND notified=0
      `).run(searchId, listingId);
    }
  }
}

function markEventsFailed(db, eventIds, errorMessage) {
  if (!eventIds.length) return;
  const ph = eventIds.map(() => "?").join(",");
  db.prepare(`UPDATE notification_events SET error=? WHERE id IN (${ph})`).run(errorMessage, ...eventIds);
}

// Update price_drop_ref after a successful price-drop notification delivery
function updatePriceDropRef(db, searchId, listingId, newRef) {
  db.prepare(`
    UPDATE search_matches SET price_drop_ref=? WHERE search_id=? AND listing_id=?
  `).run(newRef, searchId, listingId);
}

// ─── Source / search-source helpers ──────────────────────────────────────────

function getEnabledSourceSlugs(db, searchId) {
  const rows = db.prepare(`
    SELECT src.slug FROM search_sources ss
    JOIN sources src ON src.id = ss.source_id
    WHERE ss.search_id=? AND ss.enabled=1 AND src.slug != 'fixture'
  `).all(searchId);
  if (rows.length === 0) return ["facebook_marketplace", "craigslist"];
  return rows.map(r => r.slug);
}

// sourcesMap: { facebook_marketplace: true|false, craigslist: true|false }
function setSearchSources(db, searchId, sourcesMap) {
  const sourceRows = db.prepare(
    "SELECT id, slug FROM sources WHERE slug IN ('facebook_marketplace','craigslist')"
  ).all();

  const ins = db.prepare(
    "INSERT OR REPLACE INTO search_sources (search_id, source_id, enabled) VALUES (?, ?, ?)"
  );
  const tx = db.transaction(() => {
    for (const { id: sourceId, slug } of sourceRows) {
      const enabled = sourcesMap[slug] !== false ? 1 : 0;
      ins.run(searchId, sourceId, enabled);
    }
  });
  tx();
}

function getSearchSourcesMap(db, searchId) {
  const rows = db.prepare(`
    SELECT src.slug, ss.enabled
    FROM search_sources ss
    JOIN sources src ON src.id = ss.source_id
    WHERE ss.search_id=? AND src.slug != 'fixture'
  `).all(searchId);
  // Default both enabled if no rows yet
  const map = { facebook_marketplace: true, craigslist: true };
  for (const r of rows) map[r.slug] = !!r.enabled;
  return map;
}

module.exports = {
  getDb, upsertListing, upsertMatch,
  createNotificationEvent, getPendingEvents,
  markEventsDelivered, markEventsFailed, updatePriceDropRef,
  getEnabledSourceSlugs, setSearchSources, getSearchSourcesMap,
};
