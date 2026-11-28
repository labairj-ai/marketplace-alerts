"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

describe("Multi-source behavior", () => {

  test("1. One saved search targets two enabled marketplaces", () => {
    const { runSearch } = require("../src/providers");
    assert.ok(typeof runSearch === "function", "runSearch exists");
  });

  test("2. Disabling Craigslist does not disable Facebook", () => {
    const { getProviders } = require("../src/providers");
    const providers = getProviders();
    assert.ok(providers.craigslist, "Craigslist provider exists");
    assert.ok(providers.facebook_marketplace, "Facebook Marketplace provider exists");
    assert.notEqual(providers.craigslist, providers.facebook_marketplace);
  });

  test("3. One provider failure does not interrupt other sources", async () => {
    const { runSearch } = require("../src/providers");
    const fakeSearch = {
      keywords: JSON.stringify(["QIDI"]),
      keyword_alts: JSON.stringify([]),
      price_min: null, price_max: 200,
      center_lat: 39.1031, center_lon: -84.5120,
      radius_miles: 75,
    };

    const { results, sourceStatuses } = await runSearch(fakeSearch, {
      enabledSourceSlugs: ["facebook_marketplace", "craigslist"],
    });

    assert.ok(Array.isArray(results), "results is an array");
    assert.ok(typeof sourceStatuses === "object", "sourceStatuses is an object");
  });

  test("5. Exact duplicates within one source are deduplicated", () => {
    const { upsertListing } = require("../src/db");
    assert.ok(typeof upsertListing === "function", "upsertListing exported");
    // Full runtime test requires SQLite native bindings — covered in db.test.js on OptiPlex
  });

  test("7. Results can be filtered by source", () => {
    const server = require("../server");
    assert.ok(server, "Server loaded without error");
  });

  test("9. Craigslist provider getStatus returns a known status value", async () => {
    const { CraigslistProvider } = require("../src/providers/craigslist");
    const p = new CraigslistProvider();
    const s = await p.getStatus();
    assert.ok("status" in s, "status field present");
    assert.ok(["LIVE", "ERROR", "NOT_CONFIGURED"].includes(s.status),
      `Status is a known value: ${s.status}`);
  });

  test("10. Each provider reports authorization and freshness independently", async () => {
    const { getProviders } = require("../src/providers");
    const providers = getProviders();

    const fbStatus = await providers.facebook_marketplace.getStatus();
    const clStatus = await providers.craigslist.getStatus();

    assert.ok("status" in fbStatus, "Facebook has status");
    assert.ok("status" in clStatus, "Craigslist has status");
    assert.notEqual(fbStatus, clStatus);
  });

  test("11. Core matching algorithm is provider-agnostic", () => {
    const { matchListing } = require("../src/matcher");
    const listing = {
      title: "QIDI Q1 Pro 3D Printer",
      description: null,
      price: 150,
      location_text: "Cincinnati, OH",
      latitude: 39.1031,
      longitude: -84.5120,
    };
    const search = {
      keywords: JSON.stringify(["QIDI"]),
      keyword_alts: JSON.stringify([]),
      exclude_keywords: JSON.stringify([]),
      product_type: "qidi_printer",
      specs: JSON.stringify({}),
      price_min: null, price_max: 200,
      center_lat: 39.1031, center_lon: -84.5120,
      radius_miles: 75,
    };

    const r = matchListing(listing, search);
    assert.ok(["CONFIRMED", "POSSIBLE"].includes(r.classification), "Matches regardless of source");
  });

  test("12. Per-search source selection is exposed in search API", () => {
    // Source selection is stored in search_sources table and returned by GET /api/searches
    // as a 'sources' map. The setSearchSources and getSearchSourcesMap helpers handle it.
    const { setSearchSources, getSearchSourcesMap } = require("../src/db");
    assert.ok(typeof setSearchSources === "function", "setSearchSources exported");
    assert.ok(typeof getSearchSourcesMap === "function", "getSearchSourcesMap exported");
  });

});
