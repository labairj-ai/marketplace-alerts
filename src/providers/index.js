"use strict";
const { FixtureProvider } = require("./fixture");
const { FacebookMarketplaceProvider } = require("./facebook");
const { CraigslistRssProvider } = require("./craigslist");

const _providers = {};

function getProviders() {
  if (!_providers.facebook) {
    _providers.facebook = new FacebookMarketplaceProvider();
    _providers.craigslist = new CraigslistRssProvider();
    _providers.fixture = new FixtureProvider();
  }
  return _providers;
}

function getProvider(slug) {
  return getProviders()[slug] || null;
}

function isDemo() {
  return process.env.PROVIDER_MODE === "DEMO";
}

/**
 * Run a search across enabled sources for a saved search.
 * Returns { results: [...], sourceStatuses: { slug: status } }
 */
async function runSearch(savedSearch, { enabledSourceSlugs, demo = false } = {}) {
  const providers = getProviders();
  const slugs = demo ? ["fixture"] : (enabledSourceSlugs || ["facebook_marketplace", "craigslist"]);

  const results = [];
  const sourceStatuses = {};

  for (const slug of slugs) {
    const provider = providers[slug];
    if (!provider) continue;

    // Check if demo — never mix fixture with live
    if (slug === "fixture" && !demo && !isDemo()) {
      sourceStatuses[slug] = { status: "SKIPPED", message: "Demo provider skipped in NORMAL mode" };
      continue;
    }
    if (slug !== "fixture" && (demo || isDemo())) {
      sourceStatuses[slug] = { status: "SKIPPED", message: "Live provider skipped in DEMO mode" };
      continue;
    }

    try {
      const access = await provider.validateAccess();
      if (!access.ok) {
        sourceStatuses[slug] = { status: access.status, message: access.message };
        continue;
      }

      const keywords = JSON.parse(savedSearch.keywords || "[]");
      const alts = JSON.parse(savedSearch.keyword_alts || "[]");
      const allKeywords = [...keywords, ...alts];

      const raw = await provider.search({ keywords: allKeywords, search: savedSearch });

      sourceStatuses[slug] = { status: "LIVE", count: raw.length };
      results.push(...raw.map(r => ({ ...r, _sourceSlug: slug })));
    } catch (err) {
      const isAuthError = err.message?.startsWith("AUTHORIZATION_REQUIRED") ||
        err.message?.startsWith("NOT_CONFIGURED");
      sourceStatuses[slug] = {
        status: isAuthError ? err.message.split(":")[0] : "ERROR",
        message: err.message,
      };
    }
  }

  return { results, sourceStatuses };
}

module.exports = { getProvider, getProviders, runSearch, isDemo };
