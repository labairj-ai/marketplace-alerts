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

    // Fire all keyword×market combinations in parallel — each is an independent
    // HTTP request with no shared state. Dedup by PostingID after collecting.
    const pairs = keywords.flatMap(query => MARKETS.map(market => ({ query, market })));

    const allResults = await Promise.all(pairs.map(async ({ query, market }) => {
      try {
        const url = `https://${market}.craigslist.org/jsonsearch/${SECTION}/?query=${encodeURIComponent(query)}&sort=date`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10000),
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
        });
        if (!res.ok) return [];

        const data = await res.json();
        const items = Array.isArray(data[0]) ? data[0] : (Array.isArray(data) ? data : []);

        return items
          .filter(item => {
            const t = (item.PostingTitle || "").toLowerCase();
            return !(/\b(wanted|wtb|iso\s|in search of|looking for)\b/.test(t));
          })
          .map(item => ({
            source:       "craigslist",
            listingId:    String(item.PostingID || ""),
            title:        (item.PostingTitle || "").trim(),
            description:  query,
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
          }))
          .filter(l => l.listingId);
      } catch {
        return [];
      }
    }));

    // Deduplicate across all parallel results by PostingID
    const seen = new Set();
    const listings = [];
    for (const batch of allResults) {
      for (const l of batch) {
        if (seen.has(l.listingId)) continue;
        seen.add(l.listingId);
        listings.push(l);
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
