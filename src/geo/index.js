"use strict";

const CINCY = { lat: 39.1031, lon: -84.5120, label: "Cincinnati, OH" };

// City-center coordinates cache (approximate, labeled as such)
const CITY_CENTERS = {
  "cincinnati": { lat: 39.1031, lon: -84.5120 },
  "dayton":     { lat: 39.7589, lon: -84.1916 },
  "columbus":   { lat: 39.9612, lon: -82.9988 },
  "lexington":  { lat: 38.0406, lon: -84.5037 },
  "louisville": { lat: 38.2527, lon: -85.7585 },
  "indianapolis": { lat: 39.7684, lon: -86.1581 },
  "cleveland":  { lat: 41.4993, lon: -81.6944 },
  "pittsburgh": { lat: 40.4406, lon: -79.9959 },
  "detroit":    { lat: 42.3314, lon: -83.0458 },
  "chicago":    { lat: 41.8781, lon: -87.6298 },
  "nashville":  { lat: 36.1627, lon: -86.7816 },
  "atlanta":    { lat: 33.7490, lon: -84.3880 },
  "knoxville":  { lat: 35.9606, lon: -83.9207 },
  "richmond":   { lat: 37.5407, lon: -77.4360 },
  "charlotte":  { lat: 35.2271, lon: -80.8431 },
};

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * Math.PI / 180; }

/**
 * Returns { miles, approximate, unverified }
 * - miles: null if unknown
 * - approximate: true if using city-center estimate
 * - unverified: true if location cannot be measured
 */
function distanceFromSearch(listing, search) {
  const centerLat = search.center_lat ?? CINCY.lat;
  const centerLon = search.center_lon ?? CINCY.lon;

  if (listing.latitude && listing.longitude) {
    return {
      miles: haversine(centerLat, centerLon, listing.latitude, listing.longitude),
      approximate: false,
      unverified: false,
    };
  }

  // Try city-center approximation from location text
  if (listing.location_text) {
    const city = extractCity(listing.location_text);
    if (city) {
      return {
        miles: haversine(centerLat, centerLon, city.lat, city.lon),
        approximate: true,
        unverified: false,
      };
    }
  }

  return { miles: null, approximate: false, unverified: true };
}

function extractCity(locationText) {
  if (!locationText) return null;
  const lower = locationText.toLowerCase();
  for (const [name, coords] of Object.entries(CITY_CENTERS)) {
    if (lower.includes(name)) return coords;
  }
  return null;
}

module.exports = { haversine, distanceFromSearch, CINCY, CITY_CENTERS };
