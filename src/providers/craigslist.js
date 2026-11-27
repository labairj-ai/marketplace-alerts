"use strict";
const { ImapFlow } = require("imapflow");
const crypto = require("crypto");

/**
 * Craigslist Provider — Email Ingestion
 *
 * Craigslist offers official saved-search email alerts. When a user creates
 * a saved search at craigslist.org, Craigslist sends email notifications for
 * new matching listings. This provider ingests those notification emails from
 * Gmail using IMAP with the authorized app password.
 *
 * Authorization basis:
 * - The Gmail account labairj@gmail.com is owned by the user.
 * - The Gmail App Password is the user's own credential.
 * - Craigslist saved-search emails are sent with user consent.
 * - IMAP access to your own mailbox is authorized.
 *
 * This does NOT scrape craigslist.org. It reads emails from your inbox.
 *
 * Setup:
 * 1. Create saved searches at craigslist.org for your target items.
 * 2. Enable email alerts on those searches.
 * 3. Set a Gmail label (default: "Craigslist") to filter these emails.
 *    Gmail filter: from:noreply@craigslist.org → Apply label "Craigslist"
 * 4. Set EMAIL_FROM and EMAIL_APP_PASSWORD in .env.
 */

const FROM_DOMAIN = "craigslist.org";
const DEFAULT_LABEL = process.env.CRAIGSLIST_LABEL || "Craigslist";

// Regex to extract listing info from Craigslist notification emails
// Craigslist email format: each listing is a link with title, price, location
const LISTING_PATTERN =
  /https?:\/\/[\w.-]+\.craigslist\.org\/[\w/.-]+\/(\d+)\.html/gi;
const PRICE_PATTERN = /\$[\d,]+/g;

function parseListingsFromEmail(html, text, messageId) {
  const content = html || text || "";
  const listings = [];
  const seen = new Set();

  // Extract all craigslist URLs from the email
  const urlMatches = [...content.matchAll(LISTING_PATTERN)];
  for (const match of urlMatches) {
    const url = match[0];
    const externalId = match[1];

    if (seen.has(externalId)) continue;
    seen.add(externalId);

    // Extract title near this URL — look for surrounding text
    const urlIndex = content.indexOf(url);
    const before = content.substring(Math.max(0, urlIndex - 300), urlIndex);
    const after = content.substring(urlIndex, urlIndex + 300);

    const title = extractTitle(before, after);
    const price = extractPrice(before + after);
    const location = extractLocation(before + after);

    listings.push({
      source: "craigslist",
      listingId: externalId,
      title: title || `Craigslist listing ${externalId}`,
      description: null,
      price,
      currency: "USD",
      locationText: location,
      latitude: null,
      longitude: null,
      imageUrl: null,
      listingUrl: url,
      listedAt: null,
      discoveredAt: new Date().toISOString(),
      raw: { messageId, externalId, emailExtracted: true },
    });
  }

  return listings;
}

function extractTitle(before, after) {
  // Strip HTML tags
  const cleanBefore = before.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const cleanAfter = after.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  // Look for text that looks like a listing title (after last newline before URL)
  const lastLine = cleanBefore.split(/[\n\r]/).pop()?.trim();
  if (lastLine && lastLine.length > 5 && lastLine.length < 150) return lastLine;

  // Try after the URL
  const firstLine = cleanAfter.split(/[\n\r]/)[1]?.trim();
  if (firstLine && firstLine.length > 5 && firstLine.length < 150) return firstLine;

  return null;
}

function extractPrice(text) {
  const clean = text.replace(/<[^>]+>/g, " ");
  const matches = clean.match(PRICE_PATTERN);
  if (!matches) return null;
  for (const m of matches) {
    const n = parseFloat(m.replace(/[^0-9.]/g, ""));
    if (n > 0 && n < 100000) return n;
  }
  return null;
}

function extractLocation(text) {
  const clean = text.replace(/<[^>]+>/g, " ");
  // Look for city, state patterns
  const m = clean.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),\s*([A-Z]{2})\b/);
  if (m) return `${m[1]}, ${m[2]}`;
  return null;
}

class CraigslistEmailProvider {
  constructor() {
    this.slug = "craigslist";
    this.name = "Craigslist";
    this._lastCheck = null;
    this._lastError = null;
    this._configured = !!(process.env.EMAIL_FROM && process.env.EMAIL_APP_PASSWORD);
  }

  async validateAccess() {
    if (!this._configured) {
      return { ok: false, status: "NOT_CONFIGURED", message: "EMAIL_FROM and EMAIL_APP_PASSWORD required for Craigslist email ingestion." };
    }
    try {
      const client = this._createClient();
      await client.connect();
      await client.logout();
      return { ok: true, status: "LIVE" };
    } catch (err) {
      return { ok: false, status: "ERROR", message: err.message };
    }
  }

  _createClient() {
    return new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user: process.env.EMAIL_FROM,
        pass: process.env.EMAIL_APP_PASSWORD,
      },
      logger: false,
    });
  }

  /**
   * Ingest Craigslist notification emails.
   * Returns normalized listing objects.
   * Note: this is NOT a live Marketplace search — it ingests emails already received.
   */
  async search({ keywords = [] } = {}) {
    if (!this._configured) {
      throw new Error("NOT_CONFIGURED: EMAIL_FROM and EMAIL_APP_PASSWORD required.");
    }

    const client = this._createClient();
    const listings = [];

    try {
      await client.connect();

      // Look in Craigslist label folder or INBOX
      let mailbox = DEFAULT_LABEL;
      try {
        await client.mailboxOpen(mailbox);
      } catch {
        // Fall back to searching INBOX
        await client.mailboxOpen("INBOX");
        mailbox = "INBOX";
      }

      // Find recent emails from craigslist.org (last 7 days)
      const since = new Date(Date.now() - 7 * 86400000);
      const messages = await client.search({
        since,
        from: FROM_DOMAIN,
      });

      for (const uid of messages.slice(-50)) { // process up to 50 recent emails
        try {
          const msg = await client.fetchOne(uid, {
            envelope: true,
            source: true,
          });

          const source = msg.source?.toString() || "";
          const html = extractHtml(source);
          const text = extractText(source);
          const messageId = msg.envelope?.messageId || `cl-${uid}`;

          const extracted = parseListingsFromEmail(html, text, messageId);

          // Filter by keywords if provided
          for (const listing of extracted) {
            if (keywords.length === 0) {
              listings.push(listing);
            } else {
              const title = listing.title.toLowerCase();
              if (keywords.some(k => title.includes(k.toLowerCase()))) {
                listings.push(listing);
              }
            }
          }
        } catch (msgErr) {
          // Skip individual message errors
        }
      }

      await client.logout();
    } catch (err) {
      this._lastError = err.message;
      throw err;
    }

    this._lastCheck = new Date().toISOString();
    // Deduplicate by listingId
    const seen = new Set();
    return listings.filter(l => {
      if (seen.has(l.listingId)) return false;
      seen.add(l.listingId);
      return true;
    });
  }

  async normalize(raw) { return raw; }

  async getStatus() {
    if (!this._configured) {
      return { status: "NOT_CONFIGURED", lastCheck: null, error: "EMAIL_FROM and EMAIL_APP_PASSWORD not set" };
    }
    if (this._lastError) {
      return { status: "ERROR", lastCheck: this._lastCheck, error: this._lastError };
    }
    if (this._lastCheck) {
      return { status: "LIVE", lastCheck: this._lastCheck, error: null };
    }
    // Credentials configured, not yet tested
    return { status: "NOT_CONFIGURED", lastCheck: null, error: "Gmail IMAP not yet tested — will run on next scan" };
  }
}

function extractHtml(source) {
  const m = source.match(/Content-Type: text\/html[^]*?\r\n\r\n([^]*?)(?:\r\n--|\z)/i);
  return m ? m[1] : null;
}

function extractText(source) {
  const m = source.match(/Content-Type: text\/plain[^]*?\r\n\r\n([^]*?)(?:\r\n--|\z)/i);
  return m ? m[1] : null;
}

module.exports = { CraigslistEmailProvider };
