"use strict";

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { geocodeLocation } = require("../geo/geocoder");
const { haversine } = require("../geo");

const SESSION_FILE =
  process.env.FB_SESSION_FILE ||
  path.join(__dirname, "../../fb_session.json");

// --- listing data extraction ---

// imgAlt format: "Product Title in City, ST"  or  "Product Title Ships to you"
// ariaLabel format: "[badge, ]Product Title, $price, City, ST, listing XXXXXX"
// Use imgAlt as the primary source — it's the cleanest single field for title+location.
function parseCard(imgAlt, ariaLabel, spans) {
  let title = null;
  let location = null;
  let price = null;

  // imgAlt: "Product name in City, ST"
  if (imgAlt) {
    if (imgAlt.includes("Ships to you")) {
      location = "Ships to you";
      title = imgAlt.replace(/\s*Ships to you\s*$/i, "").trim() || null;
    } else {
      const m = imgAlt.match(/^(.+?) in ([A-Za-z][\w\s\-]+,\s*[A-Z]{2})$/);
      if (m) { title = m[1].trim(); location = m[2].trim(); }
      else { title = imgAlt.trim(); }
    }
  }

  // Price from spans (most reliable source)
  for (const span of spans) {
    const m = span.match(/^\$\s*([\d,]+)/);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (n > 0 && n < 1_000_000) { price = n; break; }
    }
  }

  // Fall back to ariaLabel for title if imgAlt didn't give one
  if (!title && ariaLabel) {
    // "Just listed, Title, $600, City ST, listing XXXXXX"
    const parts = ariaLabel.split(", ");
    const titleIdx = parts.findIndex(p => !/^(\$[\d,]+|listing \d+|Just listed|New listing)$/i.test(p) && p.length > 5);
    if (titleIdx >= 0) title = parts[titleIdx];
  }

  return { title, location, price };
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
        `&latitude=${lat}&longitude=${lon}&radius=100`;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(3000);

      // Keep scrolling to the last card until no new ones appear (up to ~8 rounds)
      let prevCount = 0;
      for (let i = 0; i < 8; i++) {
        const count = await page.$$eval('a[href*="/marketplace/item/"]', els => els.length);
        if (count === prevCount) break;
        prevCount = count;
        await page.evaluate(() => {
          const cards = document.querySelectorAll('a[href*="/marketplace/item/"]');
          if (cards.length) cards[cards.length - 1].scrollIntoView();
        });
        await page.waitForTimeout(2000);
      }

      const items = await page.$$eval(
        'a[href*="/marketplace/item/"]',
        anchors =>
          anchors.map(a => {
            const id = (a.href.match(/\/marketplace\/item\/(\d+)/) || [])[1];
            const spans = [...a.querySelectorAll("span")]
              .map(s => s.textContent.trim())
              .filter(s => s.length > 0 && s.length < 300);
            const img = a.querySelector("img");
            return {
              id,
              spans: spans.slice(0, 10),
              imgAlt: img ? img.alt : null,
              ariaLabel: a.getAttribute("aria-label"),
            };
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

        const { title, location, price } = parseCard(item.imgAlt, item.ariaLabel, item.spans);

        if (!title) continue;
        if (location === "Ships to you") continue;

        // Geocode the location and enforce the saved search radius
        let latitude = null;
        let longitude = null;
        if (location) {
          const coords = await geocodeLocation(location);
          if (coords) {
            const distMiles = haversine(centerLat, centerLon, coords.lat, coords.lon);
            if (distMiles > radiusMiles) continue;
            latitude  = coords.lat;
            longitude = coords.lon;
          }
          // If geocoding fails, let the listing through — matcher will mark it unverified
        }

        listings.push({
          source:       "facebook_marketplace",
          listingId:    item.id,
          title,
          description:  null,
          price,
          currency:     "USD",
          locationText: location,
          latitude,
          longitude,
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
