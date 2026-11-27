"use strict";

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const SESSION_FILE =
  process.env.FB_SESSION_FILE ||
  path.join(__dirname, "../../fb_session.json");

// --- geo helpers ---

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Approximate coords for common cities (used to filter out-of-radius FB results)
const CITY_COORDS = {
  // OH
  "cincinnati": [39.1031, -84.512], "dayton": [39.7589, -84.1916],
  "columbus": [39.9612, -82.9988], "cleveland": [41.4993, -81.6944],
  // KY
  "lexington": [38.0406, -84.5037], "louisville": [38.2527, -85.7585],
  // IN
  "indianapolis": [39.7684, -86.1581], "richmond": [39.8284, -84.8902],
  // nearby
  "hamilton": [39.3995, -84.5613], "middletown": [39.5151, -84.3983],
  "mason": [39.3598, -84.3099], "florence": [38.9989, -84.6271],
  "covington": [39.0837, -84.5085], "berea": [37.5687, -84.2963],
};

function cityInRadius(locationText, centerLat, centerLon, radiusMiles) {
  if (!locationText || locationText === "Ships to you") return false;
  const lower = locationText.toLowerCase();
  for (const [city, [lat, lon]] of Object.entries(CITY_COORDS)) {
    if (lower.includes(city)) {
      const distKm = haversineKm(centerLat, centerLon, lat, lon);
      return distKm <= radiusMiles * 1.60934;
    }
  }
  // Unknown city — use state as rough filter
  // Accept OH, KY, IN (tri-state); reject everything else
  const stateM = locationText.match(/,\s*([A-Z]{2})$/);
  if (stateM) {
    return ["OH", "KY", "IN"].includes(stateM[1]);
  }
  return false;
}

// --- listing data extraction ---

function extractPrice(spans) {
  for (const span of spans) {
    // Handle "$1,200$1,350" (current$original) or plain "$850"
    const m = span.match(/^\$\s*([\d,]+)/);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (n > 0 && n < 1_000_000) return n;
    }
  }
  return null;
}

function extractTitle(spans) {
  // Longest span that isn't just a price
  const candidates = spans.filter(s => s.length > 10 && !/^\$[\d,]+/.test(s));
  return candidates[0] || spans[spans.length - 1] || null;
}

function extractLocation(imgAlt) {
  if (!imgAlt) return null;
  // "... in City, ST" at end of alt text
  const m = imgAlt.match(/ in ([A-Za-z][A-Za-z\s]+,\s*[A-Z]{2})$/);
  if (m) return m[1].trim();
  if (imgAlt.includes("Ships to you")) return "Ships to you";
  return null;
}

// --- provider ---

class FacebookMarketplaceProvider {
  constructor() {
    this.slug = "facebook_marketplace";
    this.name = "Facebook Marketplace";
    this._lastCheck = null;
    this._lastError = null;
  }

  _hasSession() {
    return fs.existsSync(SESSION_FILE);
  }

  async validateAccess() {
    if (!this._hasSession()) {
      return {
        ok: false,
        status: "AUTHORIZATION_REQUIRED",
        message: "No Facebook session. Run: node scripts/fb-auth-setup.js",
      };
    }
    return { ok: true, status: "LIVE" };
  }

  async search({ keywords = [], search } = {}) {
    if (!this._hasSession()) {
      throw new Error("AUTHORIZATION_REQUIRED: No Facebook session file. Run: node scripts/fb-auth-setup.js");
    }

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      // Cincinnati center coords (used for geo context + URL params)
      const lat = 39.1031;
      const lon = -84.5120;

      const context = await browser.newContext({
        storageState: SESSION_FILE,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        geolocation: { latitude: lat, longitude: lon },
        permissions: ["geolocation"],
      });
      const page = await context.newPage();

      // Search with the first keyword — most specific, reduces result noise
      const keyword = keywords[0] || "";
      // 113407735336754 = Cincinnati marketplace city ID (from FB's own redirect)
      const url =
        `https://www.facebook.com/marketplace/113407735336754/search/` +
        `?query=${encodeURIComponent(keyword)}` +
        `&latitude=${lat}&longitude=${lon}&radius=100&daysSinceListed=7`;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Wait for JS-rendered listing cards
      await page.waitForTimeout(4000);

      const items = await page.$$eval(
        'a[href*="/marketplace/item/"]',
        anchors =>
          anchors.map(a => {
            const id = (a.href.match(/\/marketplace\/item\/(\d+)/) || [])[1];
            const spans = [...a.querySelectorAll("span")]
              .map(s => s.textContent.trim())
              .filter(s => s.length > 0 && s.length < 300);
            const img = a.querySelector("img");
            return { id, spans: spans.slice(0, 8), imgAlt: img ? img.alt : null };
          }).filter(x => x.id)
      );

      // Radius from saved search (default 100 mi)
      const centerLat   = search?.center_lat   ?? lat;
      const centerLon   = search?.center_lon   ?? lon;
      const radiusMiles = search?.radius_miles ?? 100;

      const seen = new Set();
      const listings = [];

      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);

        const price    = extractPrice(item.spans);
        const title    = extractTitle(item.spans);
        const location = extractLocation(item.imgAlt);

        if (!title) continue;

        // Drop listings outside the saved search radius or ships-to-you nationwide
        if (!cityInRadius(location, centerLat, centerLon, radiusMiles)) continue;

        listings.push({
          source:       "facebook_marketplace",
          listingId:    item.id,
          title,
          description:  null,
          price,
          currency:     "USD",
          locationText: location,
          latitude:     null,
          longitude:    null,
          imageUrl:     null,
          listingUrl:   `https://www.facebook.com/marketplace/item/${item.id}/`,
          listedAt:     null,
          discoveredAt: new Date().toISOString(),
          raw:          { fb: true },
        });
      }

      this._lastCheck = new Date().toISOString();
      this._lastError = null;
      return listings;
    } catch (err) {
      this._lastError = err.message;
      throw err;
    } finally {
      await browser.close();
    }
  }

  async normalize(raw) { return raw; }

  async getStatus() {
    if (!this._hasSession()) {
      return {
        status: "AUTHORIZATION_REQUIRED",
        lastCheck: null,
        error: "No FB session. Run: node scripts/fb-auth-setup.js",
      };
    }
    if (this._lastError) {
      return { status: "ERROR", lastCheck: this._lastCheck, error: this._lastError };
    }
    return { status: "LIVE", lastCheck: this._lastCheck, error: null };
  }
}

module.exports = { FacebookMarketplaceProvider };
