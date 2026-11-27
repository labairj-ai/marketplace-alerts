"use strict";
require("dotenv").config();
const { getDb } = require("./src/db");

const db = getDb();

const searches = [
  {
    name: "Apple Mac Studio 64GB+",
    enabled: 1,
    keywords: JSON.stringify(["Mac Studio", "Apple Mac Studio"]),
    keyword_alts: JSON.stringify(["M1 Ultra Mac Studio", "M2 Ultra Mac Studio", "M1 Max Mac Studio"]),
    brand: "Apple",
    product_type: "mac_studio",
    specs: JSON.stringify({ minRamGb: 64 }),
    price_min: null,
    price_max: null,
    center_lat: 39.1031,
    center_lon: -84.5120,
    center_label: "Cincinnati, OH",
    radius_miles: 75,
    exclude_keywords: JSON.stringify(["Studio Display", "MacBook Pro", "MacBook Air", "MacBook", "Mac mini", "Mac Pro", "empty enclosure", "replacement part", "for parts", "parts only"]),
    notify_email: 1,
  },
  {
    name: "QIDI Printers Under $200",
    enabled: 1,
    keywords: JSON.stringify(["QIDI", "QIDI Tech", "QIDI printer"]),
    keyword_alts: JSON.stringify(["QIDI X Plus", "QIDI X Max", "QIDI Q1 Pro", "QIDI Q2"]),
    brand: "QIDI",
    product_type: "qidi_printer",
    specs: JSON.stringify({}),
    price_min: null,
    price_max: 200,
    center_lat: 39.1031,
    center_lon: -84.5120,
    center_label: "Cincinnati, OH",
    radius_miles: 75,
    exclude_keywords: JSON.stringify(["nozzle", "extruder", "hotend", "build plate", "wanted", "looking for"]),
    notify_email: 1,
  },
];

const existing = db.prepare("SELECT COUNT(*) as n FROM saved_searches").get();
if (existing.n === 0) {
  for (const s of searches) {
    db.prepare(`
      INSERT INTO saved_searches
        (name, enabled, keywords, keyword_alts, brand, product_type, specs,
         price_min, price_max, center_lat, center_lon, center_label, radius_miles,
         exclude_keywords, notify_email)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      s.name, s.enabled, s.keywords, s.keyword_alts, s.brand, s.product_type, s.specs,
      s.price_min, s.price_max, s.center_lat, s.center_lon, s.center_label,
      s.radius_miles, s.exclude_keywords, s.notify_email
    );
  }
  console.log("Seeded 2 saved searches.");
} else {
  console.log(`${existing.n} saved searches already exist — skipping seed.`);
}
