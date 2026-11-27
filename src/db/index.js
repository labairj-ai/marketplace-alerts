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
  `);
  seedSources(db);
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    return { id: existing.id, isNew: false };
  }

  const r = db.prepare(`
    INSERT INTO search_matches (search_id, listing_id, classification, reasons)
    VALUES (?, ?, ?, ?)
  `).run(searchId, listingId, classification, JSON.stringify(reasons));
  return { id: r.lastInsertRowid, isNew: true };
}

module.exports = { getDb, upsertListing, upsertMatch };
