"use strict";
const { haversine } = require("../geo");

/**
 * Score listings on a 100-point scale relative to a saved search.
 *
 * Components:
 *   35 pts — match certainty (CONFIRMED vs POSSIBLE)
 *   30 pts — asking price (lower is better within search range)
 *   20 pts — distance from search center
 *   15 pts — listing freshness
 *
 * Scores are deterministic given the same input and are calculated relative
 * to the set of eligible listings for the search (for price normalization).
 * REJECTED listings receive score 0 and are not included in Best Fit ranking.
 */

function scoreListings(rows, search) {
  // rows: array of listing DB rows with classification, distanceMiles etc.
  // We need to compute price context from eligible (non-rejected) listings.
  const eligible = rows.filter(r => r.classification !== "REJECTED");

  const knownPrices = eligible
    .map(r => r.price)
    .filter(p => p !== null && p !== undefined);

  const priceRef = (() => {
    if (search.price_max !== null && search.price_max !== undefined) return search.price_max;
    if (knownPrices.length > 0) return Math.max(...knownPrices);
    return null;
  })();

  return rows.map(r => {
    if (r.classification === "REJECTED") {
      return { ...r, score: 0, scoreComponents: null, scoreExplanation: [] };
    }
    const { score, components, explanation } = computeScore(r, search, priceRef);
    return { ...r, score, scoreComponents: components, scoreExplanation: explanation };
  });
}

function computeScore(row, search, priceRef) {
  const components = {};
  const explanation = [];

  // ── Match certainty (35 pts) ─────────────────────────────────────────────
  if (row.classification === "CONFIRMED") {
    components.match = 35;
    explanation.push("Confirmed match");
  } else {
    components.match = 20;
    explanation.push("Possible match — not fully confirmed");
  }

  // ── Price (30 pts) ───────────────────────────────────────────────────────
  if (row.price === null || row.price === undefined) {
    components.price = 12; // conservative half-ish
    explanation.push("Price unknown");
  } else if (priceRef === null || priceRef <= 0) {
    components.price = 15;
    explanation.push("Price stated, no reference maximum");
  } else {
    // Linear: 0 price → 30 pts, priceRef price → 0 pts
    // But cap at 30 and floor at 0
    const raw = 30 * Math.max(0, (priceRef - row.price)) / priceRef;
    components.price = Math.round(Math.min(30, Math.max(0, raw)));
    if (search.price_max !== null && search.price_max !== undefined) {
      explanation.push(`$${row.price} vs $${search.price_max} max`);
    } else {
      explanation.push(`$${row.price}`);
    }
  }

  // ── Distance (20 pts) ────────────────────────────────────────────────────
  const radius = search.radius_miles || 75;
  const dist = computeDistance(row, search);

  if (dist.unverified) {
    components.distance = 8;
    explanation.push("Location unknown");
  } else {
    const raw = 20 * Math.max(0, (radius - dist.miles)) / radius;
    components.distance = Math.round(Math.min(20, Math.max(0, raw)));
    const approxNote = dist.approximate ? " (approx)" : "";
    explanation.push(`${Math.round(dist.miles)} mi from search center${approxNote}`);
  }

  // ── Freshness (15 pts) ───────────────────────────────────────────────────
  const dateStr = row.listed_at || row.discovered_at;
  const dateLabel = row.listed_at ? "listed" : "discovered";

  if (!dateStr) {
    components.freshness = 5;
    explanation.push("Date unknown");
  } else {
    const ageMs = Date.now() - new Date(dateStr).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // 30-day decay: 0 days → 15 pts, 30+ days → 0 pts
    const raw = 15 * Math.max(0, (30 - ageDays) / 30);
    components.freshness = Math.round(Math.min(15, Math.max(0, raw)));
    const days = Math.round(ageDays);
    explanation.push(days === 0 ? `${dateLabel} today` : `${dateLabel} ${days} day${days === 1 ? "" : "s"} ago`);
  }

  const score = Math.min(100, Math.max(0,
    components.match + components.price + components.distance + components.freshness
  ));

  return { score, components, explanation };
}

function computeDistance(row, search) {
  if (row.latitude && row.longitude && search.center_lat && search.center_lon) {
    return {
      miles: haversine(search.center_lat, search.center_lon, row.latitude, row.longitude),
      approximate: false,
      unverified: false,
    };
  }
  // Try to use a pre-computed distanceMiles if present (from match result)
  if (row.distance_miles !== null && row.distance_miles !== undefined) {
    return { miles: row.distance_miles, approximate: !!row.distance_approximate, unverified: false };
  }
  return { miles: null, approximate: false, unverified: true };
}

module.exports = { scoreListings, computeScore, computeDistance };
