"use strict";
const {
  upsertListing, upsertMatch,
  getEnabledSourceSlugs,
} = require("../db");
const { matchListing } = require("../matcher");
const { runSearch } = require("../providers");
const { geocodeLocation } = require("../geo/geocoder");

/**
 * Full scan pipeline for one saved search.
 *
 * Steps:
 *   1. Fetch results from enabled providers
 *   2. Upsert listings + run matcher
 *   3. Lazy-geocode FB listings missing coordinates
 *   4. Prune stale matches (criteria tightened)
 *   5. Re-evaluate previously-rejected listings (standing rule)
 *   6. Update source statuses
 *
 * Returns { results, matches, totalMatches, sourceStatuses }
 */
async function runSingleSearch(db, search, { demo = false } = {}) {
  const enabledSourceSlugs = getEnabledSourceSlugs(db, search.id);
  const { results, sourceStatuses } = await runSearch(search, { enabledSourceSlugs, demo });
  const { matches, totalMatches } = await processScanResults(db, search, results, sourceStatuses);
  return { results: results.length, matches, totalMatches, sourceStatuses };
}

/**
 * Process scan results for one saved search.
 * Called by both the scheduler and the manual /check endpoint.
 */
async function processScanResults(db, search, results, sourceStatuses) {
  const sourceRows = db.prepare("SELECT id, slug FROM sources").all();
  const sourceMap = Object.fromEntries(sourceRows.map(r => [r.slug, r.id]));

  const seenListingIds = new Set();
  let matchCount = 0;

  // ── 1. Process new scan results ───────────────────────────────────────────
  for (const item of results) {
    const sourceSlug = item._sourceSlug || "fixture";
    const sourceId = sourceMap[sourceSlug];
    if (!sourceId) continue;

    const listingId = upsertListing(db, sourceId, item);
    seenListingIds.add(listingId);
    const listing = db.prepare("SELECT * FROM listings WHERE id=?").get(listingId);
    const { classification, reasons } = matchListing(listing, search);

    if (classification === "REJECTED") {
      db.prepare("DELETE FROM search_matches WHERE search_id=? AND listing_id=?")
        .run(search.id, listingId);
      continue;
    }

    upsertMatch(db, search.id, listingId, classification, reasons);
    matchCount++;
  }

  // ── 2. Lazy-geocode FB listings with location but no coordinates ──────────
  const uncoordinated = db.prepare(`
    SELECT l.id, l.location_text FROM listings l
    JOIN sources src ON src.id = l.source_id
    WHERE src.slug = 'facebook_marketplace'
      AND l.location_text IS NOT NULL AND l.location_text != 'Ships to you'
      AND l.latitude IS NULL AND l.longitude IS NULL
    LIMIT 50
  `).all();
  if (uncoordinated.length) {
    await Promise.all(uncoordinated.map(async ({ id, location_text }) => {
      const coords = await geocodeLocation(location_text);
      if (coords) {
        db.prepare("UPDATE listings SET latitude=?, longitude=? WHERE id=?")
          .run(coords.lat, coords.lon, id);
      }
    }));
  }

  // ── 3. Prune stale matches ────────────────────────────────────────────────
  const staleCandidates = db.prepare(
    "SELECT sm.listing_id FROM search_matches sm WHERE sm.search_id=? AND sm.listing_id NOT IN (SELECT value FROM json_each(?))"
  ).all(search.id, JSON.stringify([...seenListingIds]));

  for (const { listing_id } of staleCandidates) {
    const listing = db.prepare("SELECT * FROM listings WHERE id=?").get(listing_id);
    if (!listing) {
      db.prepare("DELETE FROM search_matches WHERE search_id=? AND listing_id=?").run(search.id, listing_id);
      continue;
    }
    const { classification, reasons } = matchListing(listing, search);
    if (classification === "REJECTED") {
      db.prepare("DELETE FROM search_matches WHERE search_id=? AND listing_id=?").run(search.id, listing_id);
    } else {
      upsertMatch(db, search.id, listing_id, classification, reasons);
    }
  }

  // ── 4. Re-evaluate previously-rejected listings (standing rule) ───────────
  const rejectedCandidates = db.prepare(`
    SELECT l.id FROM listings l
    JOIN sources src ON src.id = l.source_id
    WHERE src.slug IN ('craigslist','facebook_marketplace')
      AND l.id NOT IN (SELECT listing_id FROM search_matches WHERE search_id=?)
      AND l.id NOT IN (SELECT value FROM json_each(?))
      AND l.title != ''
      AND l.title IS NOT NULL
  `).all(search.id, JSON.stringify([...seenListingIds]));

  for (const { id } of rejectedCandidates) {
    const listing = db.prepare("SELECT * FROM listings WHERE id=?").get(id);
    if (!listing) continue;
    const { classification, reasons } = matchListing(listing, search);
    if (classification === "REJECTED") continue;

    upsertMatch(db, search.id, id, classification, reasons);
    matchCount++;
  }

  // ── 5. Update source statuses ─────────────────────────────────────────────
  for (const [slug, status] of Object.entries(sourceStatuses)) {
    const sourceId = sourceMap[slug];
    if (!sourceId) continue;
    db.prepare(`
      UPDATE sources SET status=?, last_check=datetime('now'), last_error=? WHERE id=?
    `).run(status.status, status.message || status.error || null, sourceId);
  }

  const totalMatches = db.prepare(
    "SELECT COUNT(*) as n FROM search_matches WHERE search_id=?"
  ).get(search.id).n;

  return { matches: matchCount, totalMatches };
}

module.exports = { runSingleSearch, processScanResults };
