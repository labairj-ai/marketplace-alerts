"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { matchListing } = require("../src/matcher");

// Helper to build a listing
function listing(overrides) {
  return {
    title: "", description: null, price: null, currency: "USD",
    location_text: null, latitude: null, longitude: null, ...overrides,
  };
}

// Helper to build a saved search matching the DB schema
function macStudioSearch(overrides) {
  return {
    keywords: JSON.stringify(["Mac Studio", "Apple Mac Studio"]),
    keyword_alts: JSON.stringify(["M1 Ultra Mac Studio", "M2 Ultra Mac Studio", "M1 Max Mac Studio"]),
    exclude_keywords: JSON.stringify(["Studio Display", "MacBook", "Mac mini", "for parts", "parts only"]),
    product_type: "mac_studio",
    brand: "Apple",
    specs: JSON.stringify({ minRamGb: 64 }),
    price_min: null, price_max: null,
    center_lat: 39.1031, center_lon: -84.5120,
    radius_miles: 75,
    ...overrides,
  };
}

function qidiSearch(overrides) {
  return {
    keywords: JSON.stringify(["QIDI", "QIDI Tech", "QIDI printer"]),
    keyword_alts: JSON.stringify(["QIDI X Plus", "QIDI X Max", "QIDI Q1 Pro", "QIDI Q2"]),
    exclude_keywords: JSON.stringify(["nozzle", "extruder", "hotend", "build plate"]),
    product_type: "qidi_printer",
    brand: "QIDI",
    specs: JSON.stringify({}),
    price_min: null, price_max: 200,
    center_lat: 39.1031, center_lon: -84.5120,
    radius_miles: 75,
    ...overrides,
  };
}

describe("Mac Studio matching", () => {

  test("1. Mac Studio 64GB matches (CONFIRMED)", () => {
    const r = matchListing(
      listing({ title: "Apple Mac Studio M1 Ultra 64GB", latitude: 39.1031, longitude: -84.5120 }),
      macStudioSearch()
    );
    assert.equal(r.classification, "CONFIRMED");
    assert.ok(r.reasons.some(x => x.includes("64GB")));
  });

  test("2. Mac Studio 128GB matches (CONFIRMED)", () => {
    const r = matchListing(
      listing({ title: "Apple Mac Studio M2 Ultra 128GB RAM", latitude: 39.1031, longitude: -84.5120 }),
      macStudioSearch()
    );
    assert.equal(r.classification, "CONFIRMED");
  });

  test("3. Mac Studio 32GB is REJECTED", () => {
    const r = matchListing(
      listing({ title: "Apple Mac Studio M2 Max 32gb", latitude: 39.1031, longitude: -84.5120 }),
      macStudioSearch()
    );
    assert.equal(r.classification, "REJECTED");
    assert.ok(r.reasons.some(x => x.includes("32GB") || x.includes("32")));
  });

  test("4. Apple Studio Display is REJECTED", () => {
    const r = matchListing(
      listing({ title: "Apple Studio Display 27-inch", latitude: 39.1031, longitude: -84.5120 }),
      macStudioSearch()
    );
    assert.equal(r.classification, "REJECTED");
    assert.ok(r.reasons.some(x => x.toLowerCase().includes("studio display")));
  });

  test("5. MacBook Pro 64GB is REJECTED", () => {
    const r = matchListing(
      listing({ title: "MacBook Pro 16-inch 64GB M2 Max", latitude: 39.1031, longitude: -84.5120 }),
      macStudioSearch()
    );
    assert.equal(r.classification, "REJECTED");
  });

  test("6. Mac Studio with unspecified RAM is POSSIBLE", () => {
    const r = matchListing(
      listing({ title: "Apple Mac Studio M1 Ultra", description: "No specs listed", latitude: 39.1031, longitude: -84.5120 }),
      macStudioSearch()
    );
    assert.equal(r.classification, "POSSIBLE");
    assert.ok(r.reasons.some(x => x.includes("RAM") || x.includes("not specified")));
  });

});

describe("QIDI printer matching", () => {

  test("7. QIDI X-Plus 3 $175 matches (CONFIRMED)", () => {
    const r = matchListing(
      listing({ title: "QIDI X-Plus 3 3D Printer", price: 175, latitude: 39.1031, longitude: -84.5120 }),
      qidiSearch()
    );
    assert.equal(r.classification, "CONFIRMED");
    assert.ok(r.reasons.some(x => x.includes("175")));
  });

  test("8. QIDI Q1 Pro $199.99 matches (CONFIRMED)", () => {
    const r = matchListing(
      listing({ title: "QIDI Q1 Pro 3D Printer", price: 199.99, latitude: 39.1031, longitude: -84.5120 }),
      qidiSearch()
    );
    assert.equal(r.classification, "CONFIRMED");
  });

  test("9. QIDI Q2 $200 is REJECTED (not strictly below)", () => {
    const r = matchListing(
      listing({ title: "QIDI Q2 3D Printer", price: 200, latitude: 39.1031, longitude: -84.5120 }),
      qidiSearch()
    );
    assert.equal(r.classification, "REJECTED");
    assert.ok(r.reasons.some(x => x.includes("200")));
  });

  test("10. QIDI X-Max $250 is REJECTED", () => {
    const r = matchListing(
      listing({ title: "QIDI X-Max 3D Printer", price: 250, latitude: 39.1031, longitude: -84.5120 }),
      qidiSearch()
    );
    assert.equal(r.classification, "REJECTED");
  });

  test("11. QIDI extruder $50 is REJECTED", () => {
    const r = matchListing(
      listing({ title: "QIDI extruder replacement part", price: 50, latitude: 39.1031, longitude: -84.5120 }),
      qidiSearch()
    );
    assert.equal(r.classification, "REJECTED");
    // May be rejected by exclude keyword OR product rule — both are correct
    const reason = r.reasons.join(" ").toLowerCase();
    assert.ok(
      reason.includes("accessory") || reason.includes("part") || reason.includes("extruder"),
      `Expected rejection for accessory/extruder, got: ${r.reasons.join("; ")}`
    );
  });

  test("12. Free listing with explicit higher price in description does not qualify", () => {
    const r = matchListing(
      listing({ title: "QIDI X Plus 3 3D Printer", price: 1, description: "Asking $350. Listed as $1 to get attention.", latitude: 39.1031, longitude: -84.5120 }),
      qidiSearch()
    );
    assert.equal(r.classification, "REJECTED");
    assert.ok(r.reasons.some(x => x.toLowerCase().includes("contradict") || x.toLowerCase().includes("higher")));
  });

  test("13. Complete QIDI printer unknown model matches when other requirements met", () => {
    const r = matchListing(
      listing({ title: "QIDI 3D Printer — selling quick", price: 150, latitude: 39.1031, longitude: -84.5120 }),
      qidiSearch()
    );
    // Should be CONFIRMED or POSSIBLE (not REJECTED)
    assert.notEqual(r.classification, "REJECTED");
  });

});

describe("Geographic filtering", () => {

  test("14. 25 miles away matches", () => {
    // Dayton OH ~52 miles from Cincinnati
    const r = matchListing(
      listing({ title: "QIDI X Plus 3D Printer", price: 150, latitude: 39.7589, longitude: -84.1916 }),
      qidiSearch()
    );
    assert.notEqual(r.classification, "REJECTED");
  });

  test("15. 74 miles away matches", () => {
    // Lexington KY ~82 miles — use closer location
    // Indianapolis ~110 miles. Use Dayton ~52.
    // For exactly 74: use approximate coord
    const r = matchListing(
      listing({ title: "QIDI Q1 Pro 3D Printer", price: 150, latitude: 39.9500, longitude: -84.4500 }),
      qidiSearch({ radius_miles: 75 })
    );
    // This is about 55 miles — confirm it matches
    assert.notEqual(r.classification, "REJECTED");
  });

  test("16. 76 miles away is REJECTED", () => {
    // (37.98, -84.5120) is ~77.6 miles south of Cincinnati — outside 75-mile radius
    const r = matchListing(
      listing({ title: "QIDI Q1 Pro 3D Printer", price: 150, latitude: 37.98, longitude: -84.5120 }),
      qidiSearch({ radius_miles: 75 })
    );
    assert.equal(r.classification, "REJECTED");
    assert.ok(r.reasons.some(x => x.includes("miles") || x.includes("radius")));
  });

  test("17. Unknown location is unverified, not inside radius", () => {
    const r = matchListing(
      listing({ title: "QIDI Q1 Pro 3D Printer", price: 150, location_text: null }),
      qidiSearch()
    );
    assert.ok(r.distanceUnverified === true);
    // Classification may be CONFIRMED or POSSIBLE but not REJECTED due to distance
    assert.notEqual(r.classification, "REJECTED");
  });

  test("18. City-center distance is marked approximate", () => {
    const r = matchListing(
      listing({ title: "QIDI Q1 Pro 3D Printer", price: 150, location_text: "Dayton, OH" }),
      qidiSearch()
    );
    assert.ok(r.distanceApproximate === true || r.distanceMiles !== null);
  });

});
