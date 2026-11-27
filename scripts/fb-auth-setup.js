#!/usr/bin/env node
"use strict";

/**
 * One-time Facebook auth setup.
 * Opens a visible Chrome window for manual login, then saves the session
 * to fb_session.json and syncs it to the optiplex.
 *
 * Usage: node scripts/fb-auth-setup.js
 */

const { chromium } = require("playwright");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const LOCAL_SESSION = path.join(__dirname, "..", "fb_session.json");
const OPTIPLEX_SESSION = "/home/optiplex/marketplace-alerts/fb_session.json";

async function main() {
  console.log("Opening browser for Facebook login...");

  // Try using the installed Chrome; fall back to Playwright's bundled Chromium
  let browser;
  try {
    browser = await chromium.launch({ headless: false, channel: "chrome" });
  } catch {
    browser = await chromium.launch({ headless: false });
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.facebook.com/login");

  console.log("\n✓ Browser opened.");
  console.log("  Log in to Facebook. The script will continue automatically.\n");

  // Wait until redirected away from login/checkpoint pages (up to 5 min)
  await page.waitForURL(
    url => !url.includes("/login") && !url.includes("/checkpoint"),
    { timeout: 300000 }
  );

  // Brief pause for cookies to settle
  await page.waitForTimeout(2000);

  await context.storageState({ path: LOCAL_SESSION });
  await browser.close();

  console.log(`\n✓ Session saved to ${LOCAL_SESSION}`);

  // Sync to optiplex
  try {
    console.log("  Syncing to optiplex...");
    execSync(`scp "${LOCAL_SESSION}" optiplex:${OPTIPLEX_SESSION}`, { stdio: "inherit" });
    console.log("✓ Facebook Marketplace is ready.\n");
  } catch {
    console.log(
      `\n  Could not auto-sync. Run manually:\n` +
      `  scp "${LOCAL_SESSION}" optiplex:${OPTIPLEX_SESSION}\n`
    );
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
