"use strict";
const { matchMacStudio } = require("./rules/mac-studio");
const { matchQidi } = require("./rules/qidi");
const { distanceFromSearch } = require("../geo");

/**
 * Match a normalized listing against a saved search definition.
 * Returns { classification, reasons, distanceMiles, distanceApproximate, distanceUnverified }
 */
function matchListing(listing, search) {
  const combined = `${listing.title} ${listing.description || ""}`;
  const reasons = [];

  // ── 3. Product-specific rules (run before keyword/exclusion filter) ───────
  // Product rules have their own complete identity checks; keyword matching
  // serves only as a pre-filter for generic searches without a product_type.
  const productType = search.product_type || inferProductType(search);

  let productResult = null;
  if (productType === "mac_studio") {
    productResult = matchMacStudio(listing, search);
  } else if (productType === "qidi_printer") {
    productResult = matchQidi(listing, search);
  }

  if (productResult) {
    const geoResult = applyGeo(listing, search);
    return mergeResult(productResult, geoResult, listing, search);
  }

  // ── 1. Keyword matching (generic searches only) ───────────────────────────
  const keywords = parseJson(search.keywords, []);
  const alts = parseJson(search.keyword_alts, []);
  const allKeywords = [...keywords, ...alts];

  if (allKeywords.length > 0) {
    const lower = combined.toLowerCase();
    const anyMatch = allKeywords.some(kw => lower.includes(kw.toLowerCase()));
    if (!anyMatch) {
      return result("REJECTED", ["No configured search keywords matched"], listing, search);
    }
  }

  // ── 2. Exclusion keywords ────────────────────────────────────────────────
  const excludes = parseJson(search.exclude_keywords, []);
  for (const ex of excludes) {
    if (combined.toLowerCase().includes(ex.toLowerCase())) {
      return result("REJECTED", [`Excluded keyword "${ex}" found in listing`], listing, search);
    }
  }

  // ── 4. Generic matching (no product-specific rules) ──────────────────────
  reasons.push("Search keywords matched");

  // Price check
  const priceResult = checkPrice(listing, search);
  if (priceResult) {
    if (priceResult.rejected) return result("REJECTED", [...reasons, priceResult.reason], listing, search);
    reasons.push(priceResult.reason);
  }

  const geoResult = applyGeo(listing, search);
  return mergeResult({ classification: "CONFIRMED", reasons }, geoResult, listing, search);
}

function inferProductType(search) {
  const kws = JSON.stringify(search.keywords || "").toLowerCase();
  if (kws.includes("mac studio")) return "mac_studio";
  if (kws.includes("qidi")) return "qidi_printer";
  return null;
}

function checkPrice(listing, search) {
  const price = listing.price;
  if (price === null || price === undefined) {
    if (search.price_max !== null && search.price_max !== undefined) {
      return { rejected: false, reason: "Price not stated — cannot verify price requirement" };
    }
    return null;
  }

  // Contradiction detection: price $1 or $0 with text suggesting higher real price
  if (price <= 1) {
    const combined = `${listing.title} ${listing.description || ""}`.toLowerCase();
    const hasRealPrice = /\$\s*(\d{3,})\b/.test(combined);
    if (hasRealPrice) {
      return { rejected: true, reason: `Contradictory price: listed at $${price} but description suggests higher actual price` };
    }
  }

  if (search.price_max !== null && search.price_max !== undefined && price >= search.price_max) {
    return { rejected: true, reason: `Price $${price} not strictly below maximum $${search.price_max}` };
  }
  if (search.price_min !== null && search.price_min !== undefined && price < search.price_min) {
    return { rejected: true, reason: `Price $${price} below minimum $${search.price_min}` };
  }

  if (search.price_max !== null && search.price_max !== undefined) {
    return { rejected: false, reason: `Price $${price} below $${search.price_max}` };
  }
  return null;
}

function applyGeo(listing, search) {
  const { miles, approximate, unverified } = distanceFromSearch(listing, search);
  if (unverified) {
    return { geoRejected: false, geoReason: "Location unverified — not inside radius", unverified: true, miles: null, approximate: false };
  }
  const radius = search.radius_miles || 75;
  if (miles > radius) {
    return { geoRejected: true, geoReason: `Distance ${miles.toFixed(0)} miles exceeds ${radius}-mile radius`, miles, approximate };
  }
  const label = approximate ? ` (approximate city-center)` : "";
  return { geoRejected: false, geoReason: `Estimated distance ${miles.toFixed(0)} miles${label}`, miles, approximate, unverified: false };
}

function mergeResult(productResult, geoResult, listing, search) {
  const { classification, reasons } = productResult;

  if (classification === "REJECTED") {
    return { classification, reasons, ...geoInfo(geoResult) };
  }

  if (geoResult.geoRejected) {
    return { classification: "REJECTED", reasons: [...reasons, geoResult.geoReason], ...geoInfo(geoResult) };
  }

  const allReasons = [...reasons, geoResult.geoReason];

  // Price still applies for generic paths — product rules may handle their own
  const priceResult = checkPrice(listing, search);
  if (priceResult) {
    if (priceResult.rejected) return { classification: "REJECTED", reasons: [...allReasons, priceResult.reason], ...geoInfo(geoResult) };
    if (!allReasons.includes(priceResult.reason)) allReasons.push(priceResult.reason);
  }

  return { classification, reasons: allReasons, ...geoInfo(geoResult) };
}

function geoInfo(geoResult) {
  return {
    distanceMiles: geoResult.miles,
    distanceApproximate: geoResult.approximate,
    distanceUnverified: geoResult.unverified,
  };
}

function result(classification, reasons, listing, search) {
  const geo = applyGeo(listing, search);
  if (classification !== "REJECTED" && geo.geoRejected) {
    return { classification: "REJECTED", reasons: [...reasons, geo.geoReason], ...geoInfo(geo) };
  }
  return { classification, reasons, ...geoInfo(geo) };
}

function parseJson(val, def) {
  if (!val) return def;
  try { return JSON.parse(val); } catch { return def; }
}

module.exports = { matchListing };
