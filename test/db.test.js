"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Use a temp DB for tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const { getDb, upsertListing, upsertMatch } = require("../src/db");

let db;
before(() => { db = getDb(); });
after(() => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

function mkListing(overrides) {
  return {
    listingId: "test-001",
    title: "Test Listing",
    price: 100,
    currency: "USD",
    locationText: "Cincinnati, OH",
    latitude: null,
    longitude: null,
    imageUrl: null,
    listingUrl: "https://example.com/1",
    listedAt: null,
    raw: {},
    ...overrides,
  };
}

describe("Database integrity", () => {

  test("19. Repeated ingestion of same listing creates one listing record", () => {
    const sourceId = db.prepare("SELECT id FROM sources WHERE slug='fixture'").get().id;
    const item = mkListing({ listingId: "dedup-001", title: "QIDI Q1 Pro", price: 150 });

    const id1 = upsertListing(db, sourceId, item);
    const id2 = upsertListing(db, sourceId, item);
    assert.equal(id1, id2, "Same listing ID should be returned both times");

    const count = db.prepare(
      "SELECT COUNT(*) as n FROM listings WHERE source_id=? AND external_id=?"
    ).get(sourceId, "dedup-001").n;
    assert.equal(count, 1, "Only one row in DB");
  });

  test("20. Same listing can match two saved searches without duplicate listing storage", () => {
    const sourceId = db.prepare("SELECT id FROM sources WHERE slug='fixture'").get().id;
    const item = mkListing({ listingId: "multi-search-001", title: "Mac Studio", price: 1500 });
    const listingId = upsertListing(db, sourceId, item);

    // Create two searches
    const s1 = db.prepare("INSERT INTO saved_searches (name, keywords, center_lat, center_lon, radius_miles) VALUES (?,?,?,?,?)").run("Search A", "[]", 39.1031, -84.5120, 75).lastInsertRowid;
    const s2 = db.prepare("INSERT INTO saved_searches (name, keywords, center_lat, center_lon, radius_miles) VALUES (?,?,?,?,?)").run("Search B", "[]", 39.1031, -84.5120, 75).lastInsertRowid;

    upsertMatch(db, s1, listingId, "CONFIRMED", ["reason A"]);
    upsertMatch(db, s2, listingId, "CONFIRMED", ["reason B"]);

    const listingCount = db.prepare("SELECT COUNT(*) as n FROM listings WHERE external_id='multi-search-001'").get().n;
    assert.equal(listingCount, 1, "Only one physical listing record");

    const matchCount = db.prepare("SELECT COUNT(*) as n FROM search_matches WHERE listing_id=?").get(listingId).n;
    assert.equal(matchCount, 2, "Two match records, one per search");
  });

  test("21. Price reduction creates a price history record", () => {
    const sourceId = db.prepare("SELECT id FROM sources WHERE slug='fixture'").get().id;
    const item = mkListing({ listingId: "price-change-001", title: "Price Change Test", price: 300 });
    const listingId = upsertListing(db, sourceId, item);

    // Update with lower price
    upsertListing(db, sourceId, { ...item, price: 250 });

    const history = db.prepare("SELECT * FROM price_history WHERE listing_id=? ORDER BY observed_at").all(listingId);
    assert.ok(history.length >= 2, "At least 2 price history entries (initial + reduction)");
    const prices = history.map(h => h.price);
    assert.ok(prices.includes(300), "Original price 300 in history");
    assert.ok(prices.includes(250), "Reduced price 250 in history");
  });

  test("22. Unchanged listing does not send duplicate alert (notified flag)", () => {
    const sourceId = db.prepare("SELECT id FROM sources WHERE slug='fixture'").get().id;
    const item = mkListing({ listingId: "no-dup-notif-001", title: "Stable Listing", price: 180 });
    const listingId = upsertListing(db, sourceId, item);

    const searchId = db.prepare("INSERT INTO saved_searches (name, keywords, center_lat, center_lon, radius_miles) VALUES (?,?,?,?,?)").run("No-dup Search", "[]", 39.1031, -84.5120, 75).lastInsertRowid;

    const { id: matchId } = upsertMatch(db, searchId, listingId, "CONFIRMED", ["matched"]);
    db.prepare("UPDATE search_matches SET notified=1, notified_at=datetime('now') WHERE id=?").run(matchId);

    // Re-ingest same listing — should not create new match
    upsertListing(db, sourceId, item);
    const { id: matchId2 } = upsertMatch(db, searchId, listingId, "CONFIRMED", ["matched again"]);

    assert.equal(matchId, matchId2, "Same match record updated, not duplicated");

    const notified = db.prepare("SELECT notified FROM search_matches WHERE id=?").get(matchId).notified;
    assert.equal(notified, 1, "Still marked as notified");
  });

  test("23. Search configurations persist after restart (round-trip)", () => {
    db.prepare(`
      INSERT INTO saved_searches (name, keywords, keyword_alts, price_max, center_lat, center_lon, radius_miles)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("Persistence Test", JSON.stringify(["QIDI"]), JSON.stringify(["QIDI Q2"]), 200, 39.1031, -84.5120, 75);

    const loaded = db.prepare("SELECT * FROM saved_searches WHERE name='Persistence Test'").get();
    assert.ok(loaded, "Search persisted");
    assert.equal(JSON.parse(loaded.keywords)[0], "QIDI");
    assert.equal(JSON.parse(loaded.keyword_alts)[0], "QIDI Q2");
    assert.equal(loaded.price_max, 200);
  });

  test("24. SQLite migration is repeatable and non-destructive", () => {
    // Re-importing getDb should not throw and should not wipe data
    const { getDb: getDb2 } = require("../src/db");
    const db2 = getDb2();
    const count = db2.prepare("SELECT COUNT(*) as n FROM sources").get().n;
    assert.ok(count > 0, "Sources table still populated after re-initialization");
  });

});
