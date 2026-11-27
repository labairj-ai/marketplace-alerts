"use strict";

const fs   = require("fs");
const path = require("path");

const CACHE_FILE = process.env.GEO_CACHE_FILE ||
  path.join(__dirname, "../../data/geo_cache.json");

let _cache = null;
let _dirty = false;

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
  if (text in cache) return cache[text]; // may be null (failed lookup)

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
    console.warn(`[Geocoder] Failed to geocode "${text}": ${err.message}`);
    cache[text] = null;
    _dirty = true;
    saveCache();
    return null;
  }
}

module.exports = { geocodeLocation };
