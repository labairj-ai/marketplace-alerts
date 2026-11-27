"use strict";

// Known Mac Studio variants that have 64GB+ configurations by default
const HIGH_MEM_VARIANTS = [
  "m1 ultra", "m2 ultra", "m2 max 96", "m3 ultra", "m4 ultra",
];

// Explicit RAM mentions we can parse (GB)
const RAM_PATTERN = /\b(\d+)\s*(?:gb|g)\b/gi;

// Listings that mention these are definitely rejected
const REJECT_EXACT = [
  "studio display",        // Apple display, not the Mac
  "retina lcd display",    // display panel, not the Mac
  "studio fix",            // MAC Studio Fix makeup
  "conceal and correct",   // makeup product
  "macbook pro",
  "macbook air",
  "macbook",
  "mac mini",
  "mac pro",
  "empty enclosure",
  "enclosure only",
  "enclosure shell",
  "replacement part",
  "power supply",
  "logic board",
  "motherboard",
  "for parts",
  "parts only",
  "broken",
  "ssd only",              // storage drive listing, not complete computer
  "for mac studio",        // accessory for the Mac Studio, not the Mac
];

function extractRamGb(text) {
  const matches = [...text.matchAll(RAM_PATTERN)].map(m => parseInt(m[1], 10));
  if (!matches.length) return null;
  // Filter to plausible Mac RAM values (16–768 GB)
  const valid = matches.filter(n => n >= 16 && n <= 768);
  if (!valid.length) return null;
  return Math.max(...valid);
}

function isMacStudio(text) {
  return /\bmac\s+studio\b/i.test(text);
}

function isStudioDisplay(text) {
  return /\bstudio\s+display\b/i.test(text);
}

function isMacBook(text) {
  return /\bmacbook\b/i.test(text);
}

function isMacMini(text) {
  return /\bmac\s+mini\b/i.test(text);
}

function isHighMemVariant(text) {
  const lower = text.toLowerCase();
  return HIGH_MEM_VARIANTS.some(v => lower.includes(v));
}

/**
 * Returns { classification, reasons }
 * classification: "CONFIRMED" | "POSSIBLE" | "REJECTED"
 */
function matchMacStudio(listing, search) {
  const combined = `${listing.title} ${listing.description || ""}`;
  const lower = combined.toLowerCase();

  // Hard rejects first
  if (isStudioDisplay(combined)) {
    return { classification: "REJECTED", reasons: ["Apple Studio Display — not a Mac Studio computer"] };
  }
  if (isMacBook(combined) && !isMacStudio(combined)) {
    return { classification: "REJECTED", reasons: ["MacBook detected — search requires Apple Mac Studio"] };
  }
  if (isMacMini(combined) && !isMacStudio(combined)) {
    return { classification: "REJECTED", reasons: ["Mac mini detected — search requires Apple Mac Studio"] };
  }

  for (const term of REJECT_EXACT) {
    if (lower.includes(term) && !isMacStudio(combined)) {
      return { classification: "REJECTED", reasons: [`Contains "${term}" — not a complete Mac Studio`] };
    }
  }
  if (lower.includes("for parts") || lower.includes("parts only")) {
    return { classification: "REJECTED", reasons: ["Parts-only listing — search requires complete working unit"] };
  }

  // Must identify as Mac Studio
  if (!isMacStudio(combined)) {
    return { classification: "REJECTED", reasons: ["Not identified as Apple Mac Studio"] };
  }

  const reasons = ["Apple Mac Studio confirmed"];

  const ram = extractRamGb(combined);
  const specs = search.specs ? JSON.parse(search.specs) : {};
  const minRam = specs.minRamGb || 0;

  if (ram !== null) {
    if (minRam > 0 && ram < minRam) {
      // Only hard-reject if the search explicitly requires a RAM minimum
      return {
        classification: "REJECTED",
        reasons: [...reasons, `RAM ${ram}GB is below required ${minRam}GB minimum`],
      };
    }
    reasons.push(`${ram}GB RAM`);
    return { classification: "CONFIRMED", reasons };
  }

  // No RAM stated — confirm if variant implies high memory, otherwise possible
  if (isHighMemVariant(combined)) {
    reasons.push("High-memory variant — RAM not stated but typically ≥64GB");
    return { classification: "CONFIRMED", reasons };
  }

  reasons.push("RAM not stated in listing");
  return { classification: "POSSIBLE", reasons };
}

module.exports = { matchMacStudio };
