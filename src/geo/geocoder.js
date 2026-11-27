"use strict";

const fs   = require("fs");
const path = require("path");

const CACHE_FILE = process.env.GEO_CACHE_FILE ||
  path.join(__dirname, "../../data/geo_cache.json");

let _cache = null;
let _dirty = false;

// Nominatim enforces 1 req/sec per IP. Keep concurrent calls to 2 max with a
// small delay between them to stay well under the limit.
let _pendingGeo = 0;
async function _withGeoLimit(fn) {
  while (_pendingGeo >= 2) await new Promise(r => setTimeout(r, 300));
  _pendingGeo++;
  try {
    return await fn();
  } finally {
    _pendingGeo--;
  }
}

function loadCache() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    _cache = {};
  }
  return _cache;
}

function saveCache() {
  if (!_dirty) return;
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2));
    _dirty = false;
  } catch (err) {
    console.error("[Geocoder] Failed to save cache:", err.message);
  }
}

/**
 * Geocode a location string to { lat, lon } using Nominatim.
 * Returns null if geocoding fails or location is unresolvable.
 * Results are cached to disk between runs.
 */
async function geocodeLocation(text) {
  if (!text || text === "Ships to you") return null;

  const cache = loadCache();
  if (text in cache) return cache[text]; // may be null (confirmed not found)

  return _withGeoLimit(async () => {
    // Re-check cache inside the lock — another concurrent call may have populated it.
    if (text in cache) return cache[text];

    try {
      const url =
        `https://nominatim.openstreetmap.org/search` +
        `?q=${encodeURIComponent(text)}&format=json&limit=1&countrycodes=us`;

      const res = await fetch(url, {
        headers: { "User-Agent": "marketplace-alerts/1.0 (personal)" },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const coords = data[0]
        ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
        : null;

      cache[text] = coords;
      _dirty = true;
      saveCache();
      return coords;
    } catch (err) {
      // Network errors and rate-limit responses (429) are transient — don't cache
      // null so the lookup is retried next run. Only confirmed "no results" from
      // Nominatim (empty array response) should be cached as null above.
      console.warn(`[Geocoder] Failed to geocode "${text}": ${err.message}`);
      return null;
    }
  });
}

module.exports = { geocodeLocation };
