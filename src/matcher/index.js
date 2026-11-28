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

  if (keywords.length > 0) {
    // Match against TITLE ONLY — description stores the CL search query term and
    // cannot be used for qualification (any listing fetched by query "X" has "X"
    // in description, so combined always self-matches).
    const titleTokens = tokenize(listing.title);
    const primaryInTitle = keywords.some(kw => titleMatchesKeyword(kw, titleTokens));

    // Alt matching is two-tier:
    // - Multi-word alts (2+ words) are complete product names and match standalone
    //   e.g. "bounce house", "mini rebounder" match without the primary keyword present
    // - Single-word alts are qualifiers, not product names — "kids" means "kids trampoline",
    //   not "any listing with kids in the title". They must co-occur with every significant
    //   token from at least one primary keyword to form an implicit compound phrase.
    const altInTitle = alts.some(kw => altMatchesTitle(kw, titleTokens, keywords));

    if (!primaryInTitle && !altInTitle) {
      return result("REJECTED", ["No primary or alternate keywords matched listing title"], listing, search);
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

// ── Text normalization ────────────────────────────────────────────────────────

// Strip diacritics, lowercase, replace hyphens with spaces.
function normalizeText(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/-/g, " ");
}

// Split normalized text into word tokens, filtering empty strings.
function tokenize(text) {
  return normalizeText(text).split(/[\s\W]+/).filter(w => w.length > 0);
}

// Two tokens flex-match if they are equal, or — when the shorter is ≥4 chars —
// one is a prefix of the other. This handles common morphological variants:
//   "cards" ↔ "card", "collecting" ↔ "collect", "collection" ↔ "collect"
// The ≥4-char guard prevents spurious matches ("can" ≠ "candy").
function flexTokenMatch(a, b) {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

// Check if a required token appears anywhere in the title's token list.
function tokenInTitle(required, titleTokens) {
  return titleTokens.some(t => flexTokenMatch(required, t));
}

// ── Keyword matching ──────────────────────────────────────────────────────────

// All significant tokens of the keyword must appear somewhere in the title tokens.
// Token order doesn't matter; flex matching handles plurals/morphology.
// "Pokemon cards"  → ["pokemon","cards"] → matches "Pokemon Card Lot" (card≈cards)
// "Little Tikes Trampoline" → ["little","tikes","trampoline"] → matches "Little Tikes 3ft Trampoline"
function titleMatchesKeyword(kw, titleTokens) {
  const kwTokens = tokenize(kw).filter(w => w.length >= 3);
  if (kwTokens.length === 0) return false;
  return kwTokens.every(tok => tokenInTitle(tok, titleTokens));
}

// Alt keyword matching — two-tier based on token count:
//
// Multi-token alts (2+ tokens) are complete alternative product names and match
// standalone: "bounce house", "mini rebounder" match without the primary present.
//
// Single-token alts are qualifiers ("kids", "indoor"). They must co-occur with
// all significant tokens of at least one primary keyword — "kids" only matches
// if the primary concept (e.g. "trampoline") is also in the title.
function altMatchesTitle(alt, titleTokens, primaryKeywords) {
  const altTokens = tokenize(alt).filter(w => w.length >= 3);
  if (altTokens.length === 0) return false;

  if (altTokens.length >= 2) {
    return altTokens.every(tok => tokenInTitle(tok, titleTokens));
  }

  // Single-token alt: must co-occur with all significant tokens of at least one primary
  if (!tokenInTitle(altTokens[0], titleTokens)) return false;
  return primaryKeywords.some(pk => {
    const pkTokens = tokenize(pk).filter(w => w.length >= 3);
    return pkTokens.every(tok => tokenInTitle(tok, titleTokens));
  });
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
    return { geoRejected: true, geoReason: "Location unknown — cannot verify within radius", unverified: true, miles: null, approximate: false };
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
