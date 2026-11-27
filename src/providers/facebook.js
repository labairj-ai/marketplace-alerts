"use strict";

/**
 * Facebook Marketplace Provider
 *
 * Meta does not provide a public Facebook Marketplace search API for
 * consumer use. The Meta Content Library API requires academic research
 * credentials and does not cover consumer Marketplace listings. No
 * authorized third-party provider offering real-time Marketplace search
 * has been verified as of 2026.
 *
 * This adapter holds the AUTHORIZATION_REQUIRED status until an
 * authorized provider is configured and verified.
 *
 * To add a provider:
 * 1. Verify their Terms of Service permit automated Marketplace search.
 * 2. Obtain an API key and store it in FACEBOOK_PROVIDER_KEY in .env.
 * 3. Set FACEBOOK_PROVIDER_URL to their endpoint.
 * 4. Implement search() and normalize() below.
 */
class FacebookMarketplaceProvider {
  constructor() {
    this.slug = "facebook_marketplace";
    this.name = "Facebook Marketplace";
  }

  async validateAccess() {
    return {
      ok: false,
      status: "AUTHORIZATION_REQUIRED",
      message:
        "No authorized Facebook Marketplace search API is currently configured. " +
        "Meta does not provide a public consumer Marketplace API. " +
        "Contact an authorized data provider to obtain access.",
    };
  }

  async search() {
    throw new Error("AUTHORIZATION_REQUIRED: No authorized Facebook Marketplace provider configured.");
  }

  async normalize(raw) { return raw; }

  async getStatus() {
    return {
      status: "AUTHORIZATION_REQUIRED",
      lastCheck: null,
      error:
        "Meta does not provide a public consumer Marketplace search API. " +
        "No authorized third-party provider is configured.",
    };
  }
}

module.exports = { FacebookMarketplaceProvider };
