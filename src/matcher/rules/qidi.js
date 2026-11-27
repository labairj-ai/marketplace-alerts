"use strict";

// Accessories and parts — reject these even if QIDI is mentioned
const ACCESSORY_TERMS = [
  "nozzle", "hotend", "hot end", "extruder", "build plate",
  "pei sheet", "pei plate", "printhead", "print head",
  "heater block", "thermistor", "heat break", "ptfe",
  "filament sensor", "leveling sensor", "bltouch", "bl touch",
  "bed spring", "z-axis", "y-axis", "x-axis", "belt",
  "stepper motor", "power supply replacement", "replacement board",
  "mainboard", "motherboard", "controller board", "screen", "display",
  "fan duct", "cooling fan", "idler", "pulley",
];

// Explicit "wanted" or request posts
const WANTED_TERMS = ["wanted", "looking for", "iso ", "in search of", "wtb "];

// Known QIDI models — used to identify complete printers
const QIDI_MODELS = [
  "x-plus", "x plus", "x-max", "x max", "x-cf pro", "x cf pro",
  "q1 pro", "q1pro", "q2", "tech x", "i-fast", "i fast",
  "x-smart", "x smart", "x-maker", "x maker",
];

function isQidiBrand(text) {
  return /\bqidi\b/i.test(text);
}

function isCompletePrinter(text) {
  const lower = text.toLowerCase();
  // Explicit model match is strong evidence of a complete printer
  if (QIDI_MODELS.some(m => lower.includes(m))) return true;
  // "3d printer" in combination with QIDI
  if (/\b3d\s*printer\b/i.test(text)) return true;
  return false;
}

function isAccessory(text) {
  const lower = text.toLowerCase();
  return ACCESSORY_TERMS.some(t => lower.includes(t));
}

function isWanted(text) {
  const lower = text.toLowerCase();
  return WANTED_TERMS.some(t => lower.includes(t));
}

function isPartsOnly(text) {
  const lower = text.toLowerCase();
  return lower.includes("for parts") || lower.includes("parts only") ||
    lower.includes("broken") || lower.includes("non-functional") ||
    lower.includes("not working") || lower.includes("as-is") ||
    lower.includes("for repair");
}

/**
 * Returns { classification, reasons }
 */
function matchQidi(listing, search) {
  const combined = `${listing.title} ${listing.description || ""}`;

  if (!isQidiBrand(combined)) {
    return { classification: "REJECTED", reasons: ["QIDI brand not identified"] };
  }

  const reasons = ["QIDI brand matched"];

  if (isWanted(combined)) {
    return { classification: "REJECTED", reasons: [...reasons, "Wanted/request post — not a listing for sale"] };
  }

  if (isAccessory(combined)) {
    return { classification: "REJECTED", reasons: [...reasons, "Accessory or replacement part — search requires complete QIDI 3D printer"] };
  }

  if (isPartsOnly(combined)) {
    return { classification: "REJECTED", reasons: [...reasons, "Parts-only or broken printer — search requires working complete printer"] };
  }

  if (!isCompletePrinter(combined)) {
    // Not accessory, not explicitly a printer — POSSIBLE
    reasons.push("Cannot confirm complete 3D printer (no explicit model or '3D printer' in listing)");
    // Still need to check price if available
    if (listing.price !== null && listing.price !== undefined) {
      const maxPrice = search.price_max;
      if (maxPrice !== null && maxPrice !== undefined && listing.price >= maxPrice) {
        return { classification: "REJECTED", reasons: [...reasons, `Price $${listing.price} not strictly below $${maxPrice}`] };
      }
    }
    return { classification: "POSSIBLE", reasons };
  }

  reasons.push("Complete 3D printer confirmed");

  // Price check
  const maxPrice = search.price_max;
  if (maxPrice !== null && maxPrice !== undefined) {
    if (listing.price === null || listing.price === undefined) {
      reasons.push("Price not stated — cannot verify under-$200 requirement");
      return { classification: "POSSIBLE", reasons };
    }
    if (listing.price >= maxPrice) {
      return {
        classification: "REJECTED",
        reasons: [...reasons, `Price $${listing.price} not strictly below $${maxPrice}`],
      };
    }
    reasons.push(`Price $${listing.price} is strictly below $${maxPrice}`);
  }

  return { classification: "CONFIRMED", reasons };
}

module.exports = { matchQidi };
