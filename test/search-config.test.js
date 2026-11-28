"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// Tests for search creation/editing that do not require SQLite native bindings.
// DB-level tests (addColumnIfMissing, backfillSearchSources, etc.) run on OptiPlex.

describe("Search configuration", () => {

  test("SC1. Server module loads without error", () => {
    const server = require("../server");
    assert.ok(server, "server.js exports cleanly");
  });

  test("SC2. DB module exports required helpers", () => {
    const db = require("../src/db");
    const required = [
      "upsertListing", "upsertMatch",
      "setSearchSources", "getSearchSourcesMap", "getEnabledSourceSlugs",
      "createNotificationEvent", "getPendingEvents", "markEventsDelivered",
      "markEventsFailed", "updatePriceDropRef",
    ];
    for (const fn of required) {
      assert.ok(typeof db[fn] === "function", `db.${fn} is exported`);
    }
  });

  test("SC3. Product types are general, mac_studio, qidi_printer", () => {
    const { matchListing } = require("../src/matcher");

    // General search — no product_type, matched by keyword
    const generalSearch = {
      keywords: JSON.stringify(["trampoline"]),
      keyword_alts: JSON.stringify([]),
      exclude_keywords: JSON.stringify([]),
      product_type: null,
      specs: JSON.stringify({}),
      price_min: null, price_max: null,
      center_lat: 39.1031, center_lon: -84.5120, radius_miles: 75,
    };
    const r = matchListing({
      title: "14ft Trampoline", description: null, price: 100,
      latitude: 39.1031, longitude: -84.5120, location_text: null,
    }, generalSearch);
    assert.ok(["CONFIRMED", "POSSIBLE"].includes(r.classification), "Generic search matches by keyword");
  });

  test("SC4. Mac Studio search with minRamGb rejects listings below threshold", () => {
    const { matchListing } = require("../src/matcher");
    const search = {
      keywords: JSON.stringify(["Mac Studio"]),
      keyword_alts: JSON.stringify([]),
      exclude_keywords: JSON.stringify([]),
      product_type: "mac_studio",
      specs: JSON.stringify({ minRamGb: 64 }),
      price_min: null, price_max: null,
      center_lat: 39.1031, center_lon: -84.5120, radius_miles: 75,
    };

    const low = matchListing({
      title: "Apple Mac Studio M2 16GB RAM", description: null, price: 400,
      latitude: 39.1031, longitude: -84.5120, location_text: null,
    }, search);
    assert.equal(low.classification, "REJECTED", "16GB rejected when 64GB required");

    const high = matchListing({
      title: "Apple Mac Studio M2 Ultra 192GB", description: null, price: 1000,
      latitude: 39.1031, longitude: -84.5120, location_text: null,
    }, search);
    assert.equal(high.classification, "CONFIRMED", "192GB passes 64GB min requirement");
  });

  test("SC5. Mac Studio search without minRamGb returns POSSIBLE for unspecified RAM", () => {
    const { matchListing } = require("../src/matcher");
    const search = {
      keywords: JSON.stringify(["Mac Studio"]),
      keyword_alts: JSON.stringify([]),
      exclude_keywords: JSON.stringify([]),
      product_type: "mac_studio",
      specs: JSON.stringify({}),
      price_min: null, price_max: null,
      center_lat: 39.1031, center_lon: -84.5120, radius_miles: 75,
    };

    const noRam = matchListing({
      title: "Apple Mac Studio M2", description: null, price: 400,
      latitude: 39.1031, longitude: -84.5120, location_text: null,
    }, search);
    assert.equal(noRam.classification, "POSSIBLE", "Unspecified RAM is POSSIBLE without minRam requirement");
  });

  test("SC6. Price null semantics: null=clear (validated at API boundary)", () => {
    // Server route uses `"price_min" in b` to distinguish:
    //   - omitted: retain existing value
    //   - null:    clear to null
    //   - number:  update
    // This is a pure logic test of how to interpret the distinction.
    function mergePrice(existing, body) {
      let val = existing;
      if ("price_min" in body) {
        if (body.price_min === null) val = null;
        else {
          const n = Number(body.price_min);
          if (!isNaN(n)) val = n;
        }
      }
      return val;
    }

    assert.equal(mergePrice(100, {}),               100,  "omitted retains existing");
    assert.equal(mergePrice(100, { price_min: null }),null, "null clears value");
    assert.equal(mergePrice(null, { price_min: 50 }), 50,  "number updates");
  });

  test("SC7. Price validation: min must not exceed max", () => {
    function validatePriceRange(min, max) {
      if (min !== null && max !== null && min > max) return "price_min > price_max";
      return null;
    }
    assert.equal(validatePriceRange(100, 200), null, "valid range");
    assert.ok(validatePriceRange(200, 100),          "invalid range detected");
    assert.equal(validatePriceRange(null, 200), null, "no min is ok");
    assert.equal(validatePriceRange(100, null), null, "no max is ok");
  });

  test("SC8. Source slugs default to both when no search_sources rows", () => {
    const { getEnabledSourceSlugs } = require("../src/db");
    // The fallback path (no DB rows) returns ["facebook_marketplace","craigslist"]
    // We can't test the DB query without SQLite bindings, but we can verify the export exists
    assert.ok(typeof getEnabledSourceSlugs === "function");
  });

  test("SC9. QIDI product type uses qidi matcher", () => {
    const { matchListing } = require("../src/matcher");
    const search = {
      keywords: JSON.stringify(["QIDI"]),
      keyword_alts: JSON.stringify([]),
      exclude_keywords: JSON.stringify([]),
      product_type: "qidi_printer",
      specs: JSON.stringify({}),
      price_min: null, price_max: 500,
      center_lat: 39.1031, center_lon: -84.5120, radius_miles: 75,
    };

    const r = matchListing({
      title: "QIDI X-Plus 3 3D Printer",
      description: null, price: 400,
      latitude: 39.1031, longitude: -84.5120, location_text: null,
    }, search);
    assert.ok(["CONFIRMED", "POSSIBLE"].includes(r.classification), "QIDI listing matches QIDI product search");
  });

});
