"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { scoreListings, computeScore } = require("../src/scorer");

function mkRow(overrides) {
  return {
    id: 1, title: "Test Listing", price: 100, latitude: null, longitude: null,
    listed_at: null, discovered_at: new Date().toISOString(),
    classification: "CONFIRMED", reasons: ["matched"],
    ...overrides,
  };
}

function mkSearch(overrides) {
  return {
    center_lat: 39.1031, center_lon: -84.5120, radius_miles: 75,
    price_min: null, price_max: null,
    ...overrides,
  };
}

describe("Deal ranking / scorer", () => {

  test("S1. Scores stay within 0–100", () => {
    const rows = [
      mkRow({ classification:"CONFIRMED", price:50,  latitude:39.1031, longitude:-84.5120, listed_at: new Date().toISOString() }),
      mkRow({ classification:"POSSIBLE",  price:150, latitude:38.5, longitude:-84.5, listed_at: null }),
      mkRow({ classification:"CONFIRMED", price:null }),
    ];
    const search = mkSearch({ price_max: 200 });
    const scored = scoreListings(rows, search);
    for (const r of scored) {
      assert.ok(r.score >= 0 && r.score <= 100, `Score ${r.score} out of bounds`);
    }
  });

  test("S2. CONFIRMED ranks above identical POSSIBLE", () => {
    const base = { price:100, latitude:39.1031, longitude:-84.5120, listed_at: new Date().toISOString() };
    const rows = [
      mkRow({ ...base, classification:"POSSIBLE" }),
      mkRow({ ...base, classification:"CONFIRMED" }),
    ];
    const scored = scoreListings(rows, mkSearch({ price_max:200 }));
    const confirmed = scored.find(r => r.classification === "CONFIRMED");
    const possible  = scored.find(r => r.classification === "POSSIBLE");
    assert.ok(confirmed.score > possible.score, `CONFIRMED (${confirmed.score}) should beat POSSIBLE (${possible.score})`);
  });

  test("S3. Lower price scores higher when other factors equal", () => {
    const base = { classification:"CONFIRMED", latitude:39.1031, longitude:-84.5120, listed_at: new Date().toISOString() };
    const rows = [
      mkRow({ ...base, price: 50,  id: 1 }),
      mkRow({ ...base, price: 150, id: 2 }),
    ];
    const scored = scoreListings(rows, mkSearch({ price_max: 200 }));
    const cheap = scored.find(r => r.price === 50);
    const pricey = scored.find(r => r.price === 150);
    assert.ok(cheap.score > pricey.score, `Cheaper ($50 score ${cheap.score}) > pricier ($150 score ${pricey.score})`);
  });

  test("S4. Closer distance scores higher when other factors equal", () => {
    const base = { classification:"CONFIRMED", price: 100, listed_at: new Date().toISOString() };
    const rows = [
      mkRow({ ...base, latitude:39.1031, longitude:-84.5120, id:1 }), // 0 miles
      mkRow({ ...base, latitude:38.0,    longitude:-84.5120, id:2 }), // ~76 miles
    ];
    const scored = scoreListings(rows, mkSearch());
    const near = scored.find(r => r.latitude === 39.1031);
    const far  = scored.find(r => r.latitude === 38.0);
    assert.ok(near.scoreComponents.distance > far.scoreComponents.distance,
      `Closer (${near.scoreComponents.distance}) > farther (${far.scoreComponents.distance})`);
  });

  test("S5. Newer listing scores higher when other factors equal", () => {
    const base = { classification:"CONFIRMED", price:100, latitude:39.1031, longitude:-84.5120 };
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const twoWeeks  = new Date(Date.now() - 14 * 86400000).toISOString();
    const rows = [
      mkRow({ ...base, id:1, listed_at: yesterday }),
      mkRow({ ...base, id:2, listed_at: twoWeeks }),
    ];
    const scored = scoreListings(rows, mkSearch());
    const newer = scored.find(r => r.listed_at === yesterday);
    const older = scored.find(r => r.listed_at === twoWeeks);
    assert.ok(newer.scoreComponents.freshness > older.scoreComponents.freshness,
      `Newer (${newer.scoreComponents.freshness}) > older (${older.scoreComponents.freshness})`);
  });

  test("S6. Missing values do not crash and give conservative scores", () => {
    const rows = [
      mkRow({ price:null, latitude:null, longitude:null, listed_at:null, discovered_at:null, classification:"CONFIRMED" }),
    ];
    const scored = scoreListings(rows, mkSearch());
    assert.ok(scored[0].score >= 0, "Score is non-negative");
    assert.ok(scored[0].scoreComponents !== null, "Components present");
  });

  test("S7. REJECTED rows get score 0", () => {
    const rows = [mkRow({ classification:"REJECTED" })];
    const scored = scoreListings(rows, mkSearch());
    assert.equal(scored[0].score, 0);
    assert.equal(scored[0].scoreComponents, null);
  });

  test("S8. Same listing scores differently in different price contexts", () => {
    // $100 item vs $200 max = 50% savings; vs $1000 max = 90% savings → higher score with larger ref
    const row = mkRow({ price:100, latitude:39.1031, longitude:-84.5120, classification:"CONFIRMED", listed_at: new Date().toISOString() });
    const { score: scoreVs200  } = computeScore(row, mkSearch({ price_max:200 }),  200);
    const { score: scoreVs1000 } = computeScore(row, mkSearch({ price_max:1000 }), 1000);
    // Scores must differ — same listing in different contexts yields different rank
    assert.notEqual(scoreVs200, scoreVs1000, `Score differs by search context (${scoreVs200} vs ${scoreVs1000})`);
  });

  test("S9. Unknown price gets conservative score (not maximum price score)", () => {
    const withPrice    = mkRow({ price:50,   classification:"CONFIRMED" });
    const unknownPrice = mkRow({ price:null, classification:"CONFIRMED" });
    const search = mkSearch({ price_max: 200 });
    const [ sp ] = scoreListings([withPrice], search);
    const [ su ] = scoreListings([unknownPrice], search);
    // Unknown price should not get full 30 price points
    assert.ok(su.scoreComponents.price < 30, `Unknown price (${su.scoreComponents.price}) < max 30`);
    // And cheap known price should beat unknown price
    assert.ok(sp.scoreComponents.price > su.scoreComponents.price,
      `Known cheap price (${sp.scoreComponents.price}) > unknown (${su.scoreComponents.price})`);
  });

  test("S10. Unknown distance gets conservative score (not maximum)", () => {
    const withCoords  = mkRow({ latitude:39.1031, longitude:-84.5120, classification:"CONFIRMED" });
    const noLocation  = mkRow({ latitude:null, longitude:null, classification:"CONFIRMED" });
    const search = mkSearch();
    const [ sw ] = scoreListings([withCoords], search);
    const [ sn ] = scoreListings([noLocation], search);
    // Near listing (0 miles) should get max distance points (20)
    assert.equal(sw.scoreComponents.distance, 20);
    // Unknown should get conservative score, not 20
    assert.ok(sn.scoreComponents.distance < 20, `Unknown distance (${sn.scoreComponents.distance}) < 20`);
  });

});
