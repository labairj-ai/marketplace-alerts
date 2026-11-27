"use strict";

// Sample listings for DEMO mode only — clearly not live data
const FIXTURE_LISTINGS = [
  {
    source: "fixture",
    listingId: "fix-mac-001",
    title: "Apple Mac Studio M1 Ultra 64GB — Great Condition",
    description: "Mac Studio with M1 Ultra chip, 64GB unified memory, 1TB SSD. Used 8 months, works perfectly. Selling because upgrading to Mac Pro.",
    price: 1850,
    currency: "USD",
    locationText: "Cincinnati, OH",
    latitude: 39.1031,
    longitude: -84.5120,
    imageUrl: null,
    listingUrl: "https://www.facebook.com/marketplace/item/demo-001",
    listedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    discoveredAt: new Date().toISOString(),
    raw: { _fixture: true },
  },
  {
    source: "fixture",
    listingId: "fix-mac-002",
    title: "Mac Studio M2 Max — 32GB ram",
    description: "Mac Studio M2 Max, 32GB unified memory. Light use, comes with original packaging.",
    price: 1200,
    currency: "USD",
    locationText: "Dayton, OH",
    latitude: 39.7589,
    longitude: -84.1916,
    imageUrl: null,
    listingUrl: "https://www.facebook.com/marketplace/item/demo-002",
    listedAt: new Date(Date.now() - 86400000).toISOString(),
    discoveredAt: new Date().toISOString(),
    raw: { _fixture: true },
  },
  {
    source: "fixture",
    listingId: "fix-mac-003",
    title: "Apple Mac Studio M1 Ultra",
    description: "No RAM specified. Selling as-is.",
    price: 1600,
    currency: "USD",
    locationText: "Lexington, KY",
    latitude: 38.0406,
    longitude: -84.5037,
    imageUrl: null,
    listingUrl: "https://www.facebook.com/marketplace/item/demo-003",
    listedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    discoveredAt: new Date().toISOString(),
    raw: { _fixture: true },
  },
  {
    source: "fixture",
    listingId: "fix-qidi-001",
    title: "QIDI X-Plus 3 3D Printer — $175",
    description: "QIDI X-Plus 3 printer, used 6 months. Works great. Selling to get larger unit.",
    price: 175,
    currency: "USD",
    locationText: "Cincinnati, OH",
    latitude: 39.1031,
    longitude: -84.5120,
    imageUrl: null,
    listingUrl: "https://www.facebook.com/marketplace/item/demo-004",
    listedAt: new Date(Date.now() - 86400000).toISOString(),
    discoveredAt: new Date().toISOString(),
    raw: { _fixture: true },
  },
  {
    source: "fixture",
    listingId: "fix-qidi-002",
    title: "QIDI Q1 Pro 3D Printer",
    description: "QIDI Q1 Pro, lightly used. Asking $199.99.",
    price: 199.99,
    currency: "USD",
    locationText: "Dayton, OH",
    latitude: 39.7589,
    longitude: -84.1916,
    imageUrl: null,
    listingUrl: "https://www.facebook.com/marketplace/item/demo-005",
    listedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    discoveredAt: new Date().toISOString(),
    raw: { _fixture: true },
  },
  {
    source: "fixture",
    listingId: "fix-qidi-003",
    title: "QIDI X-Max 3D Printer — $250",
    description: "QIDI X-Max in great shape. Asking $250 OBO.",
    price: 250,
    currency: "USD",
    locationText: "Columbus, OH",
    latitude: 39.9612,
    longitude: -82.9988,
    imageUrl: null,
    listingUrl: "https://www.facebook.com/marketplace/item/demo-006",
    listedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
    discoveredAt: new Date().toISOString(),
    raw: { _fixture: true },
  },
];

class FixtureProvider {
  constructor() {
    this.slug = "fixture";
    this.name = "Demo (Fixture)";
  }

  async validateAccess() {
    return { ok: true, status: "DEMO" };
  }

  async search({ keywords }) {
    const kws = (keywords || []).map(k => k.toLowerCase());
    return FIXTURE_LISTINGS.filter(l => {
      const text = `${l.title} ${l.description}`.toLowerCase();
      return kws.some(k => text.includes(k));
    });
  }

  async normalize(raw) { return raw; }

  async getStatus() {
    return { status: "DEMO", lastCheck: null, error: null };
  }
}

module.exports = { FixtureProvider, FIXTURE_LISTINGS };
