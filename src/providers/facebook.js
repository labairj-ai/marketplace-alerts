"use strict";

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { geocodeLocation } = require("../geo/geocoder");
const { haversine, CITY_CENTERS } = require("../geo");

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
  let listedAt = null;

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

  // Listed date from spans — FB shows relative times ("2 days ago", "Listed today", "November 20")
  if (!listedAt) {
    const now = Date.now();
    for (const span of spans) {
      const s = span.trim();
      // "Listed today" / "Just listed"
      if (/^(listed today|just listed)$/i.test(s)) {
        listedAt = new Date(now).toISOString();
        break;
      }
      // "X hours ago"
      const hoursM = s.match(/^(\d+)\s+hours?\s+ago$/i);
      if (hoursM) {
        listedAt = new Date(now - Number(hoursM[1]) * 3600_000).toISOString();
        break;
      }
      // "X days ago"
      const daysM = s.match(/^(\d+)\s+days?\s+ago$/i);
      if (daysM) {
        listedAt = new Date(now - Number(daysM[1]) * 86_400_000).toISOString();
        break;
      }
      // "X weeks ago"
      const weeksM = s.match(/^(\d+)\s+weeks?\s+ago$/i);
      if (weeksM) {
        listedAt = new Date(now - Number(weeksM[1]) * 7 * 86_400_000).toISOString();
        break;
      }
      // "November 20" or "December 1" (absolute month/day, assume current year)
      const monthDayM = s.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})$/i);
      if (monthDayM) {
        const parsed = new Date(`${monthDayM[0]} ${new Date().getFullYear()}`);
        if (!isNaN(parsed.getTime())) { listedAt = parsed.toISOString(); break; }
      }
    }
  }

  // Fall back to ariaLabel for title and/or location if imgAlt didn't give them
  if ((!title || !location) && ariaLabel) {
    // ariaLabel: "Just listed, Title, $600, Pittsburgh, PA, listing XXXXXX"
    // Extract title
    if (!title) {
      const parts = ariaLabel.split(", ");
      const titleIdx = parts.findIndex(p => !/^(\$[\d,]+|listing \d+|Just listed|New listing)$/i.test(p) && p.length > 5);
      if (titleIdx >= 0) title = parts[titleIdx];
    }
    // Extract location — look for "City, ST" near the end of the ariaLabel
    if (!location) {
      const locM = ariaLabel.match(/,\s*([A-Za-z][A-Za-z\s\-]+),\s*([A-Z]{2})[,\s]*(listing\s+\d+)?$/);
      if (locM) location = `${locM[1].trim()}, ${locM[2]}`;
    }
  }

  return { title, location, price, listedAt };
}

// Try to extract listing date from a FB item detail page.
// FB renders something like "Listed November 20 at 2:30 PM" in a span.
// Returns ISO string or null. Best-effort: never throws.
async function fetchFbListedAt(page, itemId) {
  try {
    await page.goto(
      `https://www.facebook.com/marketplace/item/${itemId}/`,
      { waitUntil: "domcontentloaded", timeout: 15_000 }
    );
    await page.waitForTimeout(1500);

    const dateText = await page.evaluate(() => {
      // Look for "Listed <Month> <Day>" in any span text
      const spans = [...document.querySelectorAll("span")];
      for (const span of spans) {
        const t = span.textContent.trim();
        if (/^Listed\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/i.test(t)) {
          return t;
        }
      }
      // Fall back to <time> element with datetime attribute
      const time = document.querySelector("time[datetime]");
      if (time) return time.getAttribute("datetime");
      return null;
    });

    if (!dateText) return null;

    // "Listed November 20 at 2:30 PM" → parse
    const listedM = dateText.match(/^Listed\s+(.+)$/i);
    if (listedM) {
      const raw = listedM[1].replace(" at ", " ");
      const d = new Date(`${raw} ${new Date().getFullYear()}`);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    // ISO datetime from <time>
    const d = new Date(dateText);
    if (!isNaN(d.getTime())) return d.toISOString();

    return null;
  } catch {
    return null;
  }
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
      const lat = 39.1031;
      const lon = -84.5120;
      const UA  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

      const context = await browser.newContext({
        storageState: SESSION_FILE,
        userAgent: UA,
        geolocation: { latitude: lat, longitude: lon },
        permissions: ["geolocation"],
      });

      const keywordsToSearch = keywords.length > 0 ? keywords : [""];

      // Each keyword gets its own tab — all load and scroll in parallel.
      const perKeywordItems = await Promise.all(keywordsToSearch.map(async keyword => {
        const page = await context.newPage();
        try {
          const url =
            `https://www.facebook.com/marketplace/113407735336754/search/` +
            `?query=${encodeURIComponent(keyword)}` +
            `&latitude=${lat}&longitude=${lon}&radius=100`;

          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForTimeout(2000);

          // Scroll until no new cards — reduced round cap and wait for speed
          let prevCount = 0;
          for (let i = 0; i < 8; i++) {
            const count = await page.$$eval('a[href*="/marketplace/item/"]', els => els.length);
            if (count === prevCount) break;
            prevCount = count;
            await page.evaluate(() => {
              const cards = document.querySelectorAll('a[href*="/marketplace/item/"]');
              if (cards.length) cards[cards.length - 1].scrollIntoView();
            });
            await page.waitForTimeout(1200);
          }

          return page.$$eval(
            'a[href*="/marketplace/item/"]',
            anchors => anchors.map(a => {
              const id = (a.href.match(/\/marketplace\/item\/(\d+)/) || [])[1];
              const spans = [...a.querySelectorAll("span")]
                .map(s => s.textContent.trim())
                .filter(s => s.length > 0 && s.length < 300);
              const img = a.querySelector("img");
              return {
                id,
                spans: spans.slice(0, 15),
                imgAlt: img ? img.alt : null,
                ariaLabel: a.getAttribute("aria-label"),
              };
            }).filter(x => x.id)
          );
        } finally {
          await page.close();
        }
      }));

      // Merge and deduplicate across all keyword tabs
      const itemsSeen = new Set();
      const rawItems = [];
      for (const batch of perKeywordItems) {
        for (const item of batch) {
          if (!itemsSeen.has(item.id)) { itemsSeen.add(item.id); rawItems.push(item); }
        }
      }

      // Parse cards and geocode in parallel
      const centerLat   = search?.center_lat   ?? lat;
      const centerLon   = search?.center_lon   ?? lon;
      const radiusMiles = search?.radius_miles ?? 100;

      const candidates = await Promise.all(rawItems.map(async item => {
        const { title, location, price, listedAt } = parseCard(item.imgAlt, item.ariaLabel, item.spans);
        if (!title || location === "Ships to you") return null;

        // Reject listings where we cannot verify they're within the search radius.
        // FB's own radius parameter is unreliable — out-of-state results slip through.
        if (!location) return null;

        let latitude = null;
        let longitude = null;

        const coords = await geocodeLocation(location);
        if (coords) {
          const distMiles = haversine(centerLat, centerLon, coords.lat, coords.lon);
          if (distMiles > radiusMiles) return null;
          latitude  = coords.lat;
          longitude = coords.lon;
        } else {
          // Nominatim failed — try city-center lookup as a fallback
          const cityKey = Object.keys(CITY_CENTERS).find(k => location.toLowerCase().includes(k));
          if (!cityKey) return null; // unknown location, can't verify → reject
          const city = CITY_CENTERS[cityKey];
          const distMiles = haversine(centerLat, centerLon, city.lat, city.lon);
          if (distMiles > radiusMiles) return null; // city center out of range → reject
          // City center is in range — let through, lat/lon stay null
        }

        return {
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
          listedAt:     listedAt || null,
          discoveredAt: new Date().toISOString(),
          raw:          { fb: true },
        };
      }));

      const listings = candidates.filter(Boolean);

      // Fetch listed date from detail pages in parallel for items missing it.
      // Open up to 5 tabs simultaneously, capped at 10 total.
      const needDate = listings.filter(l => !l.listedAt).slice(0, 10);
      if (needDate.length > 0) {
        const CONCURRENCY = 5;
        for (let i = 0; i < needDate.length; i += CONCURRENCY) {
          const chunk = needDate.slice(i, i + CONCURRENCY);
          await Promise.all(chunk.map(async l => {
            const page = await context.newPage();
            try {
              const fetched = await fetchFbListedAt(page, l.listingId);
              if (fetched) l.listedAt = fetched;
            } finally {
              await page.close();
            }
          }));
        }
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
