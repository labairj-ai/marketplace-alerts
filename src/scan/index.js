"use strict";
const {
  upsertListing, upsertMatch,
  createNotificationEvent, getPendingEvents,
  markEventsDelivered, markEventsFailed, updatePriceDropRef,
  getEnabledSourceSlugs,
} = require("../db");
const { matchListing } = require("../matcher");
const { runSearch } = require("../providers");
const { deliverPendingEvents } = require("../notify");
const { geocodeLocation } = require("../geo/geocoder");

/**
 * Full scan pipeline for one saved search.
 *
 * Steps:
 *   1. Fetch results from enabled providers
 *   2. Upsert listings + run matcher
 *   3. Prune stale matches (criteria tightened)
 *   4. Re-evaluate previously-rejected listings (standing rule)
 *   5. Create notification events for new matches
 *   6. Detect price drops
 *   7. Update source statuses
 *   8. Deliver pending notification events (consolidated email)
 *
 * Returns { results, matches, totalMatches, sourceStatuses }
 */
async function runSingleSearch(db, search, { demo = false } = {}) {
  const enabledSourceSlugs = getEnabledSourceSlugs(db, search.id);
  const { results, sourceStatuses } = await runSearch(search, { enabledSourceSlugs, demo });

  const { matches, totalMatches } = await processScanResults(db, search, results, sourceStatuses);

  // Deliver any pending notification events (new matches + price drops) for this search
  if (search.notify_email) {
    await deliverPendingEvents(db, search);
  }

  return { results: results.length, matches, totalMatches, sourceStatuses };
}

/**
 * Process scan results for one saved search without sending email.
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

    const { id: matchId, isNew, prevClassification } = upsertMatch(db, search.id, listingId, classification, reasons);
    matchCount++;

    _handleMatchEvent(db, search, matchId, listingId, listing, classification, reasons, isNew, prevClassification);
  }

  // ── 1b. Lazy-geocode FB listings with location but no coordinates ─────────
  // Old listings pre-dating the geocoding pipeline have location_text but null
  // lat/lon. Without coordinates, distanceFromSearch returns "unverified" and
  // lets them pass the radius filter. Backfill coordinates now so subsequent
  // matchListing calls use real distances.
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

  // ── 2. Prune stale matches ────────────────────────────────────────────────
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
      // Classification may have changed (e.g. POSSIBLE→CONFIRMED) — update it
      const { id: matchId, isNew, prevClassification } = upsertMatch(db, search.id, listing_id, classification, reasons);
      _handleMatchEvent(db, search, matchId, listing_id, listing, classification, reasons, isNew, prevClassification);
    }
  }

  // ── 3. Re-evaluate previously-rejected listings (standing rule) ───────────
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

    const { id: matchId, isNew, prevClassification } = upsertMatch(db, search.id, id, classification, reasons);
    matchCount++;
    _handleMatchEvent(db, search, matchId, id, listing, classification, reasons, isNew, prevClassification);
  }

  // ── 4. Price-drop detection ───────────────────────────────────────────────
  if (search.notify_price_drop && (search.price_drop_min_dollars || search.price_drop_min_pct)) {
    _detectPriceDrops(db, search);
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

function _handleMatchEvent(db, search, matchId, listingId, listing, classification, reasons, isNew, prevClassification) {
  if (!search.notify_email) return;

  // Ensure price_drop_ref is initialized for new matches
  const matchRow = db.prepare("SELECT price_drop_ref FROM search_matches WHERE id=?").get(matchId);
  if (matchRow && matchRow.price_drop_ref === null && listing.price !== null) {
    db.prepare("UPDATE search_matches SET price_drop_ref=? WHERE id=?").run(listing.price, matchId);
  }

  if (isNew) {
    // Brand-new match — create notification event
    createNotificationEvent(db, {
      search_id:      search.id,
      listing_id:     listingId,
      event_type:     "new_match",
      classification,
      reasons:        JSON.stringify(reasons),
    });
  } else if (prevClassification === "POSSIBLE" && classification === "CONFIRMED") {
    // Classification upgraded — update any pending event; create one if none exists
    const existing = db.prepare(
      "SELECT id, notified FROM search_matches WHERE id=?"
    ).get(matchId);
    if (existing && !existing.notified) {
      // Update pending event's classification (or create if somehow missing)
      createNotificationEvent(db, {
        search_id:      search.id,
        listing_id:     listingId,
        event_type:     "new_match",
        classification,
        reasons:        JSON.stringify(reasons),
      });
    }
  }
}

function _detectPriceDrops(db, search) {
  const minDollars = search.price_drop_min_dollars;
  const minPct     = search.price_drop_min_pct;

  // Only evaluate CONFIRMED matches with a known price and a reference price
  const confirmed = db.prepare(`
    SELECT sm.id as match_id, sm.listing_id, sm.price_drop_ref,
           l.price as current_price
    FROM search_matches sm
    JOIN listings l ON l.id = sm.listing_id
    WHERE sm.search_id=?
      AND sm.classification='CONFIRMED'
      AND sm.price_drop_ref IS NOT NULL
      AND l.price IS NOT NULL
      AND l.price < sm.price_drop_ref
  `).all(search.id);

  for (const row of confirmed) {
    const priceBefore = row.price_drop_ref;
    const priceAfter  = row.current_price;
    const dollarDrop  = priceBefore - priceAfter;
    const pctDrop     = (dollarDrop / priceBefore) * 100;

    const meetsThreshold =
      (minDollars && dollarDrop >= minDollars) ||
      (minPct     && pctDrop   >= minPct);
    if (!meetsThreshold) continue;

    createNotificationEvent(db, {
      search_id:   search.id,
      listing_id:  row.listing_id,
      event_type:  "price_drop",
      price_before: priceBefore,
      price_after:  priceAfter,
    });
  }
}

module.exports = { runSingleSearch, processScanResults };
