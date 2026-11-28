"use strict";

const { haversine } = require("../geo");

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
const SECTION  = "sss"; // for-sale (all)
const PAGE_SIZE = 120;  // CL jsonsearch default page size
const MAX_PAGES = 3;    // cap at 360 results per market per keyword

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

  async search({ keywords = [], search } = {}) {
    const centerLat   = search?.center_lat   ?? 39.1031;
    const centerLon   = search?.center_lon   ?? -84.5120;
    const radiusMiles = search?.radius_miles ?? 75;
    if (!keywords.length) return [];

    // For 3+ word phrases like "Little Tikes Trampoline", CL often returns 0 for the
    // exact phrase but does have results for the product word ("trampoline").
    // Expand to also search the last word of each long phrase.
    const searchQueries = [...new Set([
      ...keywords,
      ...keywords
        .filter(kw => kw.trim().split(/\s+/).length >= 3)
        .map(kw => kw.trim().split(/\s+/).pop()),
    ])];

    // Each keyword×market combination paginates independently via the s= offset
    // parameter until CL returns a short page (last page) or MAX_PAGES is hit.
    // All pairs still run in parallel — pages within each pair are sequential.
    const pairs = searchQueries.flatMap(query => MARKETS.map(market => ({ query, market })));

    const allResults = await Promise.all(pairs.map(async ({ query, market }) => {
      const pairItems = [];
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const offset = page * PAGE_SIZE;
          const url =
            `https://${market}.craigslist.org/jsonsearch/${SECTION}/` +
            `?query=${encodeURIComponent(query)}&sort=date&s=${offset}`;
          const res = await fetch(url, {
            signal: AbortSignal.timeout(10000),
            headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
          });
          if (!res.ok) break;

          const data = await res.json();
          const raw = Array.isArray(data[0]) ? data[0] : (Array.isArray(data) ? data : []);

          const page_items = raw
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

          pairItems.push(...page_items);
          if (raw.length < PAGE_SIZE) break; // last page
        }
      } catch {
        // swallow — return whatever we collected before the error
      }
      return pairItems;
    }));

    // Deduplicate across all parallel results by PostingID, then geo-filter.
    // CL provides lat/lon directly — apply the same radius check FB does at the
    // provider level so out-of-range listings never reach the matcher or DB.
    const seen = new Set();
    const listings = [];
    for (const batch of allResults) {
      for (const l of batch) {
        if (seen.has(l.listingId)) continue;
        seen.add(l.listingId);
        if (l.latitude && l.longitude) {
          const dist = haversine(centerLat, centerLon, l.latitude, l.longitude);
          if (dist > radiusMiles) continue;
        }
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
