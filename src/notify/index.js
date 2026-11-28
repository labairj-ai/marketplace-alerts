"use strict";
const nodemailer = require("nodemailer");
const { getPendingEvents, markEventsDelivered, markEventsFailed, updatePriceDropRef } = require("../db");

let _transporter = null;

function getTransporter() {
  if (!process.env.EMAIL_FROM || !process.env.EMAIL_APP_PASSWORD) {
    throw new Error("Email not configured — set EMAIL_FROM and EMAIL_APP_PASSWORD");
  }
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_APP_PASSWORD },
    });
  }
  return _transporter;
}

/**
 * Gather all pending notification events for a saved search, send one
 * consolidated email, then mark them delivered (or failed).
 *
 * At-least-once caveat: if the process crashes after SMTP accepts the message
 * but before marking delivered, the events will be retried on the next scan.
 */
async function deliverPendingEvents(db, search) {
  const events = getPendingEvents(db, search.id);
  if (!events.length) return;

  const newMatchEvents  = events.filter(e => e.event_type === "new_match");
  const priceDropEvents = events.filter(e => e.event_type === "price_drop");

  const totalCount = events.length;
  const subject = buildSubject(search.name, newMatchEvents.length, priceDropEvents.length);
  const html    = buildHtml(search.name, newMatchEvents, priceDropEvents);

  const transport = getTransporter(); // throws if unconfigured

  await transport.sendMail({
    from: `"Marketplace Alerts" <${process.env.EMAIL_FROM}>`,
    to:   process.env.EMAIL_TO || process.env.EMAIL_FROM,
    subject,
    html,
  });

  // Only reaches here on SMTP success
  const eventIds = events.map(e => e.id);
  const matchListingIds = events.map(e => ({ searchId: e.search_id, listingId: e.listing_id }));
  markEventsDelivered(db, eventIds, matchListingIds);

  // Advance price_drop_ref for delivered price-drop events
  for (const e of priceDropEvents) {
    if (e.price_after !== null && e.price_after !== undefined) {
      updatePriceDropRef(db, e.search_id, e.listing_id, e.price_after);
    }
  }

  console.log(`[Notify] Delivered ${totalCount} event(s) for "${search.name}"`);
}

async function deliverPendingEventsWithRetry(db, search) {
  try {
    await deliverPendingEvents(db, search);
  } catch (err) {
    const events = getPendingEvents(db, search.id);
    if (events.length) {
      markEventsFailed(db, events.map(e => e.id), err.message);
    }
    console.error(`[Notify] Delivery failed for "${search.name}": ${err.message}`);
  }
}

async function sendTestEmail() {
  const transport = getTransporter(); // throws if unconfigured
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  await transport.sendMail({
    from: `"Marketplace Alerts" <${process.env.EMAIL_FROM}>`,
    to:   process.env.EMAIL_TO || process.env.EMAIL_FROM,
    subject: "Marketplace Alerts — Test Email",
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:32px;background:#f1f5f9;">
      <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0;">
        <h2 style="color:#0f172a;margin-bottom:8px;">✓ Test Email</h2>
        <p style="color:#475569;margin-bottom:16px;">Your Marketplace Alerts email configuration is working correctly.</p>
        <p style="color:#94a3b8;font-size:13px;">Sent at ${now}</p>
      </div>
    </body></html>`,
  });
}

function buildSubject(searchName, newCount, dropCount) {
  const parts = [];
  if (newCount  > 0) parts.push(`${newCount} new match${newCount  > 1 ? "es" : ""}`);
  if (dropCount > 0) parts.push(`${dropCount} price drop${dropCount > 1 ? "s" : ""}`);
  const summary = parts.join(", ");
  return `🔔 Marketplace Alerts — ${searchName} — ${summary}`;
}

function buildHtml(searchName, newMatchEvents, priceDropEvents) {
  const fmt     = p => (p !== null && p !== undefined) ? `$${Number(p).toLocaleString()}` : "—";
  const fmtPct  = p => `${Number(p).toFixed(1)}%`;
  const date    = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });

  function matchRow(e, i) {
    const bg    = i % 2 === 0 ? "#fafafa" : "#f4f4f4";
    const cls   = e.classification || "CONFIRMED";
    const badge = cls === "CONFIRMED"
      ? `<span style="background:#dcfce7;color:#16a34a;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;">CONFIRMED</span>`
      : `<span style="background:#fef3c7;color:#b45309;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;">POSSIBLE</span>`;
    const reasons = (() => {
      try { return JSON.parse(e.reasons || "[]").slice(0,3).join("; "); } catch { return ""; }
    })();
    const src = (e.source_slug || "").includes("facebook") ? "FB" : "CL";
    return `<tr style="background:${bg};border-bottom:1px solid #e5e7eb;">
      <td style="padding:10px 12px;">${badge}</td>
      <td style="padding:10px 12px;font-weight:600;font-size:13px;">${e.listing_title || "—"}</td>
      <td style="padding:10px 12px;font-weight:700;font-size:14px;">${fmt(e.current_price)}</td>
      <td style="padding:10px 12px;font-size:11px;color:#6b7280;">${src}</td>
      <td style="padding:10px 12px;font-size:11px;color:#6b7280;">${e.location_text || "—"}</td>
      <td style="padding:10px 12px;font-size:11px;color:#6b7280;">${reasons}</td>
      <td style="padding:10px 8px;text-align:center;">${e.listing_url
        ? `<a href="${e.listing_url}" style="color:#2563eb;font-size:12px;">View →</a>` : "—"}</td>
    </tr>`;
  }

  function dropRow(e, i) {
    const bg       = i % 2 === 0 ? "#fafafa" : "#f4f4f4";
    const before   = e.price_before;
    const after    = e.price_after ?? e.current_price;
    const dollar   = (before && after) ? (before - after) : null;
    const pct      = (before && after && before > 0) ? ((before - after) / before * 100) : null;
    return `<tr style="background:${bg};border-bottom:1px solid #e5e7eb;">
      <td style="padding:10px 12px;font-weight:600;font-size:13px;">${e.listing_title || "—"}</td>
      <td style="padding:10px 12px;font-size:13px;text-decoration:line-through;color:#9ca3af;">${fmt(before)}</td>
      <td style="padding:10px 12px;font-weight:700;font-size:14px;color:#16a34a;">${fmt(after)}</td>
      <td style="padding:10px 12px;font-size:12px;color:#16a34a;">${dollar ? `−${fmt(dollar)}` : "—"}</td>
      <td style="padding:10px 12px;font-size:12px;color:#16a34a;">${pct ? fmtPct(pct) : "—"}</td>
      <td style="padding:10px 12px;font-size:11px;color:#6b7280;">${e.location_text || "—"}</td>
      <td style="padding:10px 8px;text-align:center;">${e.listing_url
        ? `<a href="${e.listing_url}" style="color:#2563eb;font-size:12px;">View →</a>` : "—"}</td>
    </tr>`;
  }

  const matchSection = newMatchEvents.length > 0 ? `
    <div style="margin-bottom:24px;">
      <div style="background:#166534;color:#fff;padding:10px 14px;border-radius:8px 8px 0 0;font-size:11px;font-weight:700;letter-spacing:0.08em;">
        ✅ NEW MATCHES — ${newMatchEvents.length}
      </div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">
        <thead><tr style="background:#f0fdf4;">
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#166534;white-space:nowrap;">STATUS</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#166534;">TITLE</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#166534;">PRICE</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#166534;">SRC</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#166534;">LOCATION</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#166534;">REASON</th>
          <th style="padding:7px 8px;font-size:10px;color:#166534;"></th>
        </tr></thead>
        <tbody>${newMatchEvents.map((e,i) => matchRow(e,i)).join("")}</tbody>
      </table>
    </div>` : "";

  const dropSection = priceDropEvents.length > 0 ? `
    <div style="margin-bottom:24px;">
      <div style="background:#0369a1;color:#fff;padding:10px 14px;border-radius:8px 8px 0 0;font-size:11px;font-weight:700;letter-spacing:0.08em;">
        📉 PRICE DROPS — ${priceDropEvents.length}
      </div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-top:none;">
        <thead><tr style="background:#f0f9ff;">
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#0369a1;">TITLE</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#0369a1;">WAS</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#0369a1;">NOW</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#0369a1;">DROP $</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#0369a1;">DROP %</th>
          <th style="padding:7px 12px;text-align:left;font-size:10px;color:#0369a1;">LOCATION</th>
          <th style="padding:7px 8px;font-size:10px;color:#0369a1;"></th>
        </tr></thead>
        <tbody>${priceDropEvents.map((e,i) => dropRow(e,i)).join("")}</tbody>
      </table>
    </div>` : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:760px;margin:0 auto;padding:0 0 32px;">
  <div style="background:#0f172a;padding:20px 28px;margin-bottom:24px;">
    <div style="font-size:9px;color:#94a3b8;letter-spacing:0.2em;margin-bottom:6px;">MARKETPLACE ALERTS</div>
    <div style="font-size:20px;font-weight:700;color:#f8fafc;">🔔 ${escapeHtml(searchName)}</div>
    <div style="font-size:11px;color:#64748b;margin-top:4px;">${date}</div>
  </div>
  <div style="padding:0 20px;">
    ${matchSection}${dropSection}
    <div style="text-align:center;font-size:10px;color:#94a3b8;padding-top:14px;border-top:1px solid #e2e8f0;">
      MARKETPLACE ALERTS · SELF-HOSTED ON OPTIPLEX
    </div>
  </div>
</div></body></html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { deliverPendingEvents, deliverPendingEventsWithRetry, sendTestEmail };
