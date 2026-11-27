"use strict";
const nodemailer = require("nodemailer");

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_APP_PASSWORD,
    },
  });
  return _transporter;
}

function buildAlertHtml(matches) {
  const confirmed = matches.filter(m => m.classification === "CONFIRMED");
  const possible = matches.filter(m => m.classification === "POSSIBLE");

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const fmt = p => p !== null && p !== undefined ? `$${Number(p).toFixed(0)}` : "—";

  function matchRow(m, i) {
    const bg = i % 2 === 0 ? "#fdfaf2" : "#f8f2e4";
    const badge = m.classification === "CONFIRMED"
      ? `<span style="background:#e0f2e8;border:1px solid #1a6b38;color:#1a6b38;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;">CONFIRMED</span>`
      : `<span style="background:#fff3cd;border:1px solid #7a5a00;color:#7a5a00;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;">POSSIBLE</span>`;
    const reasons = JSON.parse(m.reasons || "[]").slice(0, 3).join("; ");
    return `<tr style="background:${bg};border-bottom:1px solid #e8dcc8;">
      <td style="padding:10px 14px;">${badge}</td>
      <td style="padding:10px 14px;font-weight:600;font-size:13px;color:#12243d;">${m.listing_title}</td>
      <td style="padding:10px 14px;font-weight:700;font-size:14px;color:#12243d;">${fmt(m.price)}</td>
      <td style="padding:10px 14px;font-size:11px;color:#8a7a60;">${m.location_text || "—"}</td>
      <td style="padding:10px 14px;font-size:11px;color:#6a5a40;">${reasons}</td>
      <td style="padding:10px 8px;text-align:center;">${m.listing_url ? `<a href="${m.listing_url}" style="color:#1a4a8a;font-size:12px;">View →</a>` : "—"}</td>
    </tr>`;
  }

  const confirmedRows = confirmed.map((m, i) => matchRow(m, i)).join("");
  const possibleRows = possible.map((m, i) => matchRow(m, i)).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f0e8d4;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:720px;margin:0 auto;padding:0 0 32px;">
  <div style="background:#12243d;padding:20px 28px;margin-bottom:24px;">
    <div style="font-size:9px;color:#a89878;letter-spacing:0.2em;margin-bottom:6px;">MARKETPLACE ALERTS</div>
    <div style="font-size:20px;font-weight:700;color:#f2ead8;">🔔 New Matching Listings</div>
    <div style="font-size:11px;color:#7a8898;margin-top:4px;">${date}</div>
  </div>
  <div style="padding:0 20px;">
    ${confirmed.length > 0 ? `
    <div style="background:#fdfaf2;border:1.5px solid #1a6b38;border-radius:10px;overflow:hidden;margin-bottom:20px;">
      <div style="padding:11px 14px;background:#1a6b38;">
        <span style="font-size:10px;color:#fff;letter-spacing:0.12em;font-weight:700;">✅ CONFIRMED MATCHES — ${confirmed.length} LISTING${confirmed.length>1?"S":""}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#e0f2e8;">
          <th style="padding:8px 14px;text-align:left;font-size:9px;color:#1a6b38;letter-spacing:0.1em;">STATUS</th>
          <th style="padding:8px 14px;text-align:left;font-size:9px;color:#1a6b38;letter-spacing:0.1em;">TITLE</th>
          <th style="padding:8px 14px;text-align:right;font-size:9px;color:#1a6b38;letter-spacing:0.1em;">PRICE</th>
          <th style="padding:8px 14px;text-align:left;font-size:9px;color:#1a6b38;letter-spacing:0.1em;">LOCATION</th>
          <th style="padding:8px 14px;text-align:left;font-size:9px;color:#1a6b38;letter-spacing:0.1em;">REASONS</th>
          <th style="padding:8px 14px;font-size:9px;color:#1a6b38;letter-spacing:0.1em;"></th>
        </tr></thead>
        <tbody>${confirmedRows}</tbody>
      </table>
    </div>` : ""}
    ${possible.length > 0 ? `
    <div style="background:#fdfaf2;border:1.5px solid #7a5a00;border-radius:10px;overflow:hidden;margin-bottom:20px;">
      <div style="padding:11px 14px;background:#f4edd8;border-bottom:1px solid #d4c4a0;">
        <span style="font-size:10px;color:#7a5a00;letter-spacing:0.12em;font-weight:700;">⚠️ POSSIBLE MATCHES — ${possible.length} LISTING${possible.length>1?"S":""} (review needed)</span>
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#fff3cd;">
          <th style="padding:8px 14px;text-align:left;font-size:9px;color:#7a5a00;letter-spacing:0.1em;">STATUS</th>
          <th style="padding:8px 14px;text-align:left;font-size:9px;color:#7a5a00;letter-spacing:0.1em;">TITLE</th>
          <th style="padding:8px 14px;text-align:right;font-size:9px;color:#7a5a00;letter-spacing:0.1em;">PRICE</th>
          <th style="padding:8px 14px;text-align:left;font-size:9px;color:#7a5a00;letter-spacing:0.1em;">LOCATION</th>
          <th style="padding:8px 14px;text-align:left;font-size:9px;color:#7a5a00;letter-spacing:0.1em;">REASONS</th>
          <th style="padding:8px 14px;font-size:9px;color:#7a5a00;letter-spacing:0.1em;"></th>
        </tr></thead>
        <tbody>${possibleRows}</tbody>
      </table>
    </div>` : ""}
    <div style="text-align:center;font-size:10px;color:#b8a888;letter-spacing:0.1em;padding-top:14px;border-top:1px solid #d8caa8;">MARKETPLACE ALERTS · SELF-HOSTED ON OPTIPLEX</div>
  </div>
</div></body></html>`;
}

async function sendAlertEmail(searchName, matches) {
  if (!process.env.EMAIL_FROM || !process.env.EMAIL_APP_PASSWORD) return;
  if (!matches.length) return;

  const confirmed = matches.filter(m => m.classification === "CONFIRMED").length;
  const possible = matches.filter(m => m.classification === "POSSIBLE").length;

  const subject = `🔔 ${confirmed > 0 ? `${confirmed} Confirmed` : `${possible} Possible`} Match${matches.length > 1 ? "es" : ""} — ${searchName}`;

  await getTransporter().sendMail({
    from: `"Marketplace Alerts" <${process.env.EMAIL_FROM}>`,
    to: process.env.EMAIL_TO || process.env.EMAIL_FROM,
    subject,
    html: buildAlertHtml(matches),
  });
}

module.exports = { sendAlertEmail };
