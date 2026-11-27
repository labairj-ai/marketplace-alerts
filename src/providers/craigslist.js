"use strict";

/**
 * Craigslist Provider — RSS Feed Polling
 *
 * Craigslist publishes official public RSS feeds for every search:
 *   https://{market}.craigslist.org/search/{section}?format=rss&query={term}&sort=date
 *
 * No authentication, no scraping, no IMAP. We fetch the RSS on each
 * scheduler cycle and extract current listings across regional markets.
 *
 * Markets within ~75 miles of Cincinnati (39.10, -84.51):
 *   cincinnati  ~0 mi
 *   dayton      ~55 mi
 *   lexington   ~80 mi  (included; geo filter rejects far listings)
 *   columbus    ~105 mi (included; geo filter rejects far listings)
 */

// Markets to scan. Geo filter in matcher will reject anything outside radius.
const MARKETS = ["cincinnati", "dayton", "lexington", "columbus"];

// Craigslist for-sale section
const SECTION = "sss";

// Approximate city centers for geo estimation when lat/lon not in RSS
const CITY_COORDS = {
  cincinnati:  { lat: 39.1031, lon: -84.5120 },
  dayton:      { lat: 39.7589, lon: -84.1916 },
  lexington:   { lat: 38.0406, lon: -84.5037 },
  columbus:    { lat: 39.9612, lon: -82.9988 },
};

function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"))
    || xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function getLinkFromItem(item) {
  // <link> in RSS 2.0 appears as text after the tag, not as an XML child
  // Craigslist puts the URL as plain text between <link> tags
  const m = item.match(/<link>(https?:\/\/[^\s<]+)<\/link>/i)
    || item.match(/<link\s[^>]*href="([^"]+)"/i)
    || item.match(/(https?:\/\/[\w.-]+\.craigslist\.org\/[\w/.-]+\/\d+\.html)/i);
  return m ? m[1].trim() : null;
}

function extractPrice(text) {
  if (!text) return null;
  const clean = text.replace(/<[^>]+>/g, " ");
  const m = clean.match(/\$\s*([\d,]+)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return n > 0 && n < 1000000 ? n : null;
}

function extractLocation(text) {
  if (!text) return null;
  const clean = text.replace(/<[^>]+>/g, " ");
  const m = clean.match(/([A-Z][a-zA-Z\s]+),\s*([A-Z]{2})\b/);
  return m ? `${m[1].trim()}, ${m[2]}` : null;
}

function stripHtml(html) {
  if (!html) return null;
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 500) || null;
}

function parseRssItems(xml, market) {
  const items = [];
  const seen = new Set();
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let m;

  while ((m = itemPattern.exec(xml)) !== null) {
    const raw = m[1];
    const link = getLinkFromItem(raw);
    if (!link) continue;

    const idMatch = link.match(/\/(\d+)\.html/);
    if (!idMatch) continue;
    const externalId = idMatch[1];
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const title   = getTag(raw, "title")        || "";
    const desc    = getTag(raw, "description")  || "";
    const pubDate = getTag(raw, "pubDate") || getTag(raw, "dc:date");
    const imgUrl  = raw.match(/enclosure[^>]+url="([^"]+)"/i)?.[1] || null;

    const price    = extractPrice(title) ?? extractPrice(desc);
    const location = extractLocation(desc) || `${market.charAt(0).toUpperCase() + market.slice(1)}, OH`;
    const coords   = CITY_COORDS[market] || null;

    items.push({
      source:      "craigslist",
      listingId:   externalId,
      title:       title.replace(/\s+/g, " ").trim(),
      description: stripHtml(desc),
      price,
      currency:    "USD",
      locationText: location,
      latitude:    coords?.lat ?? null,
      longitude:   coords?.lon ?? null,
      imageUrl:    imgUrl,
      listingUrl:  link,
      listedAt:    pubDate ? new Date(pubDate).toISOString() : null,
      discoveredAt: new Date().toISOString(),
      raw:         { rss: true, market },
    });
  }

  return items;
}

class CraigslistRssProvider {
  constructor() {
    this.slug = "craigslist";
    this.name = "Craigslist";
    this._lastCheck = null;
    this._lastError = null;
  }

  async validateAccess() {
    try {
      const url = `https://cincinnati.craigslist.org/search/${SECTION}?format=rss&query=test&sort=date`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, status: "LIVE" };
    } catch (err) {
      return { ok: false, status: "ERROR", message: err.message };
    }
  }

  /**
   * Search for listings via Craigslist RSS across regional markets.
   * Uses first keyword only (most specific) to avoid flooding markets with requests.
   */
  async search({ keywords = [] } = {}) {
    if (!keywords.length) return [];

    // Use the most specific keyword (usually the shortest distinct phrase)
    const query = keywords[0];
    const listings = [];
    const seen = new Set();

    for (const market of MARKETS) {
      try {
        const url = `https://${market}.craigslist.org/search/${SECTION}?format=rss&query=${encodeURIComponent(query)}&sort=date`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const xml = await res.text();
        const items = parseRssItems(xml, market);
        for (const item of items) {
          if (seen.has(item.listingId)) { continue; }
          seen.add(item.listingId);
          listings.push(item);
        }
      } catch {
        // Skip markets that time out or error — don't fail the whole scan
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
    if (this._lastCheck) {
      return { status: "LIVE", lastCheck: this._lastCheck, error: null };
    }
    return { status: "LIVE", lastCheck: null, error: null };
  }
}

module.exports = { CraigslistRssProvider };
