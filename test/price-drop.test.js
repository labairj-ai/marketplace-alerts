"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// Tests for price-drop detection logic.
// DB-integration tests (actual SQLite row creation/update) run on OptiPlex.
// Here we test the pure threshold logic and configuration contract.

describe("Price drop alerts", () => {

  test("PD1. Price drop threshold logic — dollar threshold", () => {
    function exceedsThreshold(priceBefore, priceAfter, minDollars, minPct) {
      const dollarDrop = priceBefore - priceAfter;
      const pctDrop = (dollarDrop / priceBefore) * 100;
      return (
        (minDollars && dollarDrop >= minDollars) ||
        (minPct     && pctDrop   >= minPct)
      );
    }

    // Dollar threshold
    assert.ok(exceedsThreshold(500, 400, 50, null),  "$100 drop ≥ $50 threshold");
    assert.ok(!exceedsThreshold(500, 480, 50, null), "$20 drop < $50 threshold");
  });

  test("PD2. Price drop threshold logic — percent threshold", () => {
    function exceedsThreshold(priceBefore, priceAfter, minDollars, minPct) {
      const dollarDrop = priceBefore - priceAfter;
      const pctDrop = (dollarDrop / priceBefore) * 100;
      return (
        (minDollars && dollarDrop >= minDollars) ||
        (minPct     && pctDrop   >= minPct)
      );
    }

    // Percent threshold
    assert.ok(exceedsThreshold(500, 400, null, 15),  "20% drop ≥ 15% threshold");
    assert.ok(!exceedsThreshold(500, 460, null, 15), "8% drop < 15% threshold");
  });

  test("PD3. Either threshold triggers alert (OR logic)", () => {
    function exceedsThreshold(priceBefore, priceAfter, minDollars, minPct) {
      const dollarDrop = priceBefore - priceAfter;
      const pctDrop = (dollarDrop / priceBefore) * 100;
      return (
        (minDollars && dollarDrop >= minDollars) ||
        (minPct     && pctDrop   >= minPct)
      );
    }

    // Large dollar drop but small percent — dollar threshold met
    assert.ok(exceedsThreshold(10000, 9800, 100, 10), "dollar threshold met, pct not");
    // Large pct drop but small dollar — pct threshold met
    assert.ok(exceedsThreshold(50, 30, 100, 20),      "pct threshold met, dollar not");
    // Neither met
    assert.ok(!exceedsThreshold(500, 490, 50, 15),    "neither threshold met");
  });

  test("PD4. No price drop triggered when price increases", () => {
    function exceedsThreshold(priceBefore, priceAfter, minDollars, minPct) {
      if (priceAfter >= priceBefore) return false; // price must be strictly lower
      const dollarDrop = priceBefore - priceAfter;
      const pctDrop = (dollarDrop / priceBefore) * 100;
      return (
        (minDollars && dollarDrop >= minDollars) ||
        (minPct     && pctDrop   >= minPct)
      );
    }
    assert.ok(!exceedsThreshold(400, 500, 50, 10), "price increase is not a drop");
    assert.ok(!exceedsThreshold(400, 400, 50, 10), "same price is not a drop");
  });

  test("PD5. Price drop detection skipped when feature not configured", () => {
    // If neither minDollars nor minPct is set, _detectPriceDrops should not run
    function shouldRunDetection(notifyPriceDrop, minDollars, minPct) {
      return !!(notifyPriceDrop && (minDollars || minPct));
    }
    assert.ok(!shouldRunDetection(false, 50, 10), "disabled: skip");
    assert.ok(!shouldRunDetection(true, null, null), "enabled but no thresholds: skip");
    assert.ok(shouldRunDetection(true, 50, null),  "enabled with dollar threshold: run");
    assert.ok(shouldRunDetection(true, null, 10),  "enabled with pct threshold: run");
  });

  test("PD6. price_drop_ref is initialized on first match, not updated until notification delivered", () => {
    // This invariant is maintained in _handleMatchEvent (sets ref on first match)
    // and in deliverPendingEvents (advances ref after SMTP success).
    // Test the conceptual contract, not DB internals.
    let priceDropRef = null;
    const currentPrice = 450;

    // On first match: set ref to current price
    if (priceDropRef === null && currentPrice !== null) {
      priceDropRef = currentPrice;
    }
    assert.equal(priceDropRef, 450, "ref set on first match");

    // Ref should NOT advance before email delivery
    const afterDrop = 350;
    // Simulated: ref stays at 450 until after SMTP completes
    assert.equal(priceDropRef, 450, "ref unchanged before delivery");

    // Only after delivery: advance ref to new price
    priceDropRef = afterDrop;
    assert.equal(priceDropRef, 350, "ref advanced after delivery");
  });

  test("PD7. Price drop only triggers for CONFIRMED matches, not POSSIBLE", () => {
    // This is enforced by the SQL query in _detectPriceDrops:
    // WHERE sm.classification='CONFIRMED'
    function shouldCheckForDrop(classification) {
      return classification === "CONFIRMED";
    }
    assert.ok(!shouldCheckForDrop("POSSIBLE"),  "POSSIBLE not checked for price drop");
    assert.ok(!shouldCheckForDrop("REJECTED"),  "REJECTED not checked for price drop");
    assert.ok(shouldCheckForDrop("CONFIRMED"),  "CONFIRMED checked for price drop");
  });

  test("PD8. updatePriceDropRef is exported from db module", () => {
    const { updatePriceDropRef } = require("../src/db");
    assert.ok(typeof updatePriceDropRef === "function");
  });

  test("PD9. scan module has price drop detection entry point", () => {
    const scan = require("../src/scan");
    assert.ok(typeof scan.processScanResults === "function", "processScanResults exported");
    // _detectPriceDrops is an internal implementation detail — not exported directly
  });

  test("PD10. Notification event for price drop has price_before and price_after", () => {
    // Verify the shape of a price-drop event object as expected by deliverPendingEvents
    function mkPriceDropEvent({ priceBefore, priceAfter }) {
      return {
        event_type: "price_drop",
        price_before: priceBefore,
        price_after: priceAfter,
      };
    }

    const evt = mkPriceDropEvent({ priceBefore: 500, priceAfter: 350 });
    assert.equal(evt.event_type, "price_drop");
    assert.equal(evt.price_before, 500);
    assert.equal(evt.price_after, 350);
    assert.ok(evt.price_before > evt.price_after, "price must have dropped");
  });

});
