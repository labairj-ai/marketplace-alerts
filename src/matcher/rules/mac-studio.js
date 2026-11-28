"use strict";

// Known Mac Studio variants that have 64GB+ configurations by default
const HIGH_MEM_VARIANTS = [
  "m1 ultra", "m2 ultra", "m2 max 96", "m3 ultra", "m4 ultra",
];

// Explicit RAM mentions we can parse (GB)
const RAM_PATTERN = /\b(\d+)\s*(?:gb|g)\b/gi;
// Storage context: a GB value immediately followed by a storage keyword is not RAM
const STORAGE_PATTERN = /\b(\d+)\s*gb\s+(?:ssd|hdd|nvme|flash|storage|drive)\b/gi;
// RAM-explicit context: "XGB RAM", "XGB memory", "XGB unified memory"
// Note: "RAM XGB" patterns are NOT used here because "36GB RAM 512GB SSD" would
// match "RAM 512GB" and pick up the storage value. Only match GB→RAM direction.
const RAM_EXPLICIT_PATTERN = /\b(\d+)\s*gb\s+(?:ram|memory|unified\s+memory)\b/gi;

// Listings that mention these are definitely rejected — checked BEFORE the
// isMacStudio guard so makeup/accessory listings with "MAC Studio" in the name
// are caught unconditionally.
const REJECT_ALWAYS = [
  "studio fix",            // MAC Studio Fix makeup brand
  "conceal and correct",   // makeup product
  "colour corrector",      // makeup product
  "color corrector",       // makeup product
  "retina lcd display",    // replacement display panel, not the computer
  "ssd only",              // storage drive, not complete computer
];

// Rejected unless the listing is explicitly a Mac Studio computer
const REJECT_EXACT = [
  "studio display",        // Apple display
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
  "for mac studio",        // accessory for the Mac Studio
];

function extractRamGb(text) {
  // Priority 1: explicit RAM/memory context ("36GB RAM", "64GB unified memory")
  const explicit = [
    ...[...text.matchAll(RAM_EXPLICIT_PATTERN)].map(m => parseInt(m[1], 10)),
  ].filter(n => n >= 16 && n <= 768);
  if (explicit.length > 0) return Math.max(...explicit);

  // Priority 2: any GB value, but exclude values immediately adjacent to storage keywords
  const storageValues = new Set(
    [...text.matchAll(STORAGE_PATTERN)].map(m => parseInt(m[1], 10))
  );
  const all = [...text.matchAll(RAM_PATTERN)]
    .map(m => parseInt(m[1], 10))
    .filter(n => n >= 16 && n <= 768 && !storageValues.has(n));
  if (!all.length) return null;
  return Math.max(...all);
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

  // Unconditional rejects — makeup/accessories that happen to include "MAC Studio"
  for (const term of REJECT_ALWAYS) {
    if (lower.includes(term)) {
      return { classification: "REJECTED", reasons: [`Contains "${term}" — not an Apple Mac Studio computer`] };
    }
  }

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

  // "for mac studio" = accessory listing — reject even when "Mac Studio" appears
  if (lower.includes("for mac studio")) {
    return { classification: "REJECTED", reasons: ['"for mac studio" — accessory for Mac Studio, not the computer itself'] };
  }

  // Identity must appear in the listing TITLE — description stores the CL search
  // query term and cannot be trusted to establish what the listing actually is.
  if (!isMacStudio(listing.title)) {
    return { classification: "REJECTED", reasons: ["Not identified as Apple Mac Studio in listing title"] };
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

  // No RAM stated — cannot verify requirement without explicit confirmation
  reasons.push(isHighMemVariant(combined)
    ? "High-memory variant — RAM not stated, cannot verify against requirement"
    : "RAM not stated in listing");
  return { classification: "POSSIBLE", reasons };
}

module.exports = { matchMacStudio };
