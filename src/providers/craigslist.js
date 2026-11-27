"use strict";

/**
 * Craigslist Provider — JSON Search API
 *
 * Uses Craigslist's undocumented-but-stable JSON search endpoint:
 *   https://{market}.craigslist.org/jsonsearch/{section}/?query={term}
 *
 * Returns structured data (title, price, lat/lon, timestamp, URL) without
 * needing Playwright or authentication. The endpoint is accessible from
 * server IPs unlike the RSS feed.
 *
 * Markets scanned (within ~100 mi of Cincinnati):
 *   cincinnati  ~0 mi
 *   dayton      ~55 mi
 *   lexington   ~80 mi
 *   columbus    ~105 mi
 */

const MARKETS = ["cincinnati", "dayton", "lexington", "columbus"];
const SECTION = "sss"; // for-sale (all)

class CraigslistProvider {
  constructor() {
    this.slug = "craigslist";
    this.name = "Craigslist";
    this._lastCheck = null;
    this._lastError = null;
  }

  async validateAccess() {
    try {
      const url = `https://cincinnati.craigslist.org/jsonsearch/${SECTION}/?query=test`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, status: "LIVE" };
    } catch (err) {
      return { ok: false, status: "ERROR", message: err.message };
    }
  }

  async search({ keywords = [] } = {}) {
    if (!keywords.length) return [];

    // Use first keyword (most specific)
    const query = keywords[0];
    const seen = new Set();
    const listings = [];

    for (const market of MARKETS) {
      try {
        const url = `https://${market}.craigslist.org/jsonsearch/${SECTION}/?query=${encodeURIComponent(query)}&sort=date`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10000),
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
        });
        if (!res.ok) continue;

        const data = await res.json();
        // Response is [[...listings], metadata] or just [...listings]
        const items = Array.isArray(data[0]) ? data[0] : (Array.isArray(data) ? data : []);

        for (const item of items) {
          const id = String(item.PostingID || "");
          if (!id || seen.has(id)) continue;
          seen.add(id);

          listings.push({
            source:       "craigslist",
            listingId:    id,
            title:        (item.PostingTitle || "").trim(),
            description:  null,
            price:        item.price != null ? Number(item.price) : null,
            currency:     "USD",
            locationText: null,
            latitude:     item.Latitude  != null ? Number(item.Latitude)  : null,
            longitude:    item.Longitude != null ? Number(item.Longitude) : null,
            imageUrl:     item.ImageThumb || null,
            listingUrl:   item.PostingURL || null,
            listedAt:     item.PostedDate ? new Date(item.PostedDate * 1000).toISOString() : null,
            discoveredAt: new Date().toISOString(),
            raw:          { market, cl: true },
          });
        }
      } catch {
        // Skip markets that fail — don't block the whole scan
      }
    }

    this._lastCheck = new Date().toISOString();
    this._lastError = null;
    return listings;
  }

  async normalize(raw) { return raw; }

  async getStatus() {
    if (this._lastError) {
      return { status: "ERROR", lastCheck: this._lastCheck, error: this._lastError };
    }
    return { status: "LIVE", lastCheck: this._lastCheck, error: null };
  }
}

module.exports = { CraigslistProvider };
