// Completion alerts for the insurance survey (Phase 1: quotes are prepared
// offline, so the team needs a prompt telling them a survey just landed).
//
// Two independent channels — one failing never blocks the other, and neither
// can ever block or undo the saved submission (callers wrap this in
// try/catch as well):
//
//  1. EMAIL, via a small Google Apps Script web app (apps-script/
//     insurance_alert_webhook.gs). The bot POSTs JSON over HTTPS and the
//     script sends the mail. This avoids SMTP entirely, which many hosting
//     plans restrict, and needs no new npm package or email provider.
//  2. WHATSAPP, straight from the Cloud API. Free-form text only reaches a
//     number that messaged the bot in the last 24 hours; otherwise Meta
//     rejects it (error 131047) and we fall back to a pre-approved template
//     if ALERT_WA_TEMPLATE is configured.
//
// Configuration (all environment variables, none hard-coded):
//   ALERT_EMAIL_TO          recipient address(es), comma separated
//   ALERT_WEBHOOK_URL       the Apps Script web-app URL
//   ALERT_WEBHOOK_SECRET    shared secret the script checks
//   ALERT_WHATSAPP_TO       recipient WhatsApp number (07..., 254..., or +254...)
//   ALERT_WA_TEMPLATE       optional approved template name (4 body variables)
//   ALERT_WA_TEMPLATE_LANG  optional template language code (default "en")

const axios = require("axios");
const whatsapp = require("./whatsapp");
const insurance = require("./surveys/insurance");

const { kes, formatDob } = insurance.helpers;

// 0710601030 / +254 710 601 030 / 254710601030  ->  254710601030
function normalizeKenyanNumber(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`; // 710601030
  return digits;
}

function flagTags(flags) {
  const tags = [];
  const has = (prefix) => flags.some((f) => f.startsWith(prefix));
  if (has("SPECIAL_CLEARANCE")) tags.push("SPECIAL CLEARANCE");
  if (has("MEDICAL_REQUIRED")) tags.push("MEDICAL REQUIRED");
  if (has("MEDICAL_CHECK_RIDERS")) tags.push("CHECK RIDERS");
  if (has("AGE_BOUNDARY")) tags.push("AGE BOUNDARY");
  return tags;
}


// ---------------------------------------------------------------- HTML email
// A formatted version of the alert (tables + inline styles only, because mail
// programs such as Outlook ignore modern CSS). The plain-text version is still
// sent alongside it as a fallback. EVERY value that came from the client or
// the survey goes through esc(), so nothing a person types (a name, a note) can
// inject markup or break the layout.
const BRAND = "#c8102e";

function esc(v) {
  return String(v === undefined || v === null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ISO timestamp -> "2026-10-06 10:44 (Nairobi)"
function nairobiStamp(iso) {
  const d = new Date(new Date(iso).getTime() + 3 * 3600 * 1000);
  if (isNaN(d)) return String(iso || "");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} (Nairobi)`;
}

function buildHtml({ sub, a, flags, tags, joint, revision }) {
  const row = (label, value) =>
    `<tr><td width="190" style="width:190px;padding:7px 12px 7px 0;color:#667085;font-size:13px;vertical-align:top;border-bottom:1px solid #eef0f3;">${esc(label)}</td>` +
    `<td style="padding:7px 0;color:#101828;font-size:14px;font-weight:600;vertical-align:top;border-bottom:1px solid #eef0f3;">${esc(value)}</td></tr>`;

  const section = (title, rowsHtml) =>
    `<tr><td style="padding:20px 28px 6px 28px;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${BRAND};font-weight:700;">${esc(title)}</div></td></tr>` +
    `<tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;">${rowsHtml}</table></td></tr>`;

  const proposer = [
    row("Name", a.fullName),
    row("WhatsApp", `+${a.proposerWaId}`),
    row("Email", a.email || "not given"),
    row("Lead source", a.source || "Direct"),
    row("Date of birth", `${formatDob(a.dateOfBirth)} (age ${a.ageAtSubmission})`),
    row("Gender", a.gender),
    row("Smoker", a.smoker),
  ].join("");

  const spouse = joint
    ? [
        row("Date of birth", `${formatDob(a.spouseDob)} (age ${a.spouseAge})`),
        row("Gender", a.spouseGender),
        row("Smoker", a.spouseSmoker),
      ].join("")
    : "";

  const coverRows = [
    row("Plan", a.plan + (a.plan === "Plan B" ? " (critical illness built in)" : "")),
    row("Cover type", a.coverType),
    row("Premium term", a.premiumTerm),
    row("Quote based on", a.calcMode === "Premium" ? "Premium" : "Cover amount"),
    row("Payment frequency", a.paymentFrequency),
  ];
  if (a.modalPremium !== undefined) coverRows.push(row("Premium (incl. riders)", `${kes(a.modalPremium)} ${String(a.paymentFrequency).toLowerCase()}`));
  if (a.sumAssured !== undefined) coverRows.push(row("Sum assured", kes(a.sumAssured)));
  if (a.ciRider) coverRows.push(row("Critical illness rider", a.ciRider + (a.ciAmount ? ` - ${kes(a.ciAmount)}` : "")));
  if (a.accidentRider) coverRows.push(row("Accident rider", a.accidentRider + (a.accidentAmount ? ` - ${kes(a.accidentAmount)}` : "")));
  if (a.estTaxRelief !== "" && a.estTaxRelief !== undefined) coverRows.push(row("Indicative annual tax relief", kes(a.estTaxRelief)));

  const checks = [row("Medical exam", a.medicalRequired), row("Special clearance", a.specialClearance)].join("");

  const chips = tags
    .map(
      (t) =>
        `<span style="display:inline-block;background:${BRAND};color:#ffffff;padding:3px 10px;margin:0 6px 6px 0;font-size:12px;font-weight:700;">${esc(t)}</span>`
    )
    .join("");

  const flagItem = (f) => {
    const i = f.indexOf(":");
    const head = i > 0 ? f.slice(0, i) : f;
    const rest = i > 0 ? f.slice(i + 1).trim() : "";
    const hot = /^(SPECIAL_CLEARANCE|MEDICAL_REQUIRED|MEDICAL_CHECK_RIDERS|AGE_BOUNDARY)/.test(head);
    return (
      `<tr><td style="padding:5px 0;font-size:13px;color:#344054;line-height:18px;">` +
      `<span style="font-weight:700;color:${hot ? BRAND : "#475467"};">${esc(head)}</span>${rest ? " &ndash; " + esc(rest) : ""}</td></tr>`
    );
  };
  const flagsHtml = flags.length ? section("Flags", flags.map(flagItem).join("")) : "";

  const notesHtml = a.notes
    ? `<tr><td style="padding:20px 28px 0 28px;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${BRAND};font-weight:700;">Notes from client</div>` +
      `<div style="margin-top:6px;padding:10px 12px;background:#f9fafb;border:1px solid #eaecf0;font-size:14px;color:#101828;white-space:pre-wrap;">${esc(a.notes)}</div></td></tr>`
    : "";

  const revisionHtml = revision
    ? `<tr><td style="padding:12px 28px 0 28px;"><div style="background:#fffaeb;border:1px solid #fedf89;padding:10px 12px;font-size:13px;color:#93370d;"><b>Revised submission</b> &ndash; this replaces an earlier request from the same number (${esc(a.revisionOf)}). Use these details.</div></td></tr>`
    : "";

  const waDigits = String(a.proposerWaId || "").replace(/\D/g, "");
  const button = waDigits
    ? `<tr><td style="padding:24px 28px 8px 28px;"><a href="https://wa.me/${waDigits}" style="display:inline-block;background:#1a9d54;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;">Reply to client on WhatsApp</a></td></tr>`
    : "";

  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head>` +
    `<body style="margin:0;padding:0;background:#f2f4f7;font-family:Segoe UI,Arial,Helvetica,sans-serif;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;"><tr><td align="center" style="padding:20px 10px;">` +
    `<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:#ffffff;border:1px solid #e4e7ec;">` +
    `<tr><td style="background:${BRAND};padding:18px 28px;"><div style="color:#ffffff;font-size:12px;letter-spacing:1px;text-transform:uppercase;">New PRULife survey</div>` +
    `<div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:4px;">${esc(a.fullName)}</div>` +
    `<div style="color:#ffffff;font-size:13px;margin-top:4px;">Ref ${esc(sub.referenceNumber)} &middot; ${esc(nairobiStamp(sub.submittedAt))}</div></td></tr>` +
    (chips ? `<tr><td style="padding:16px 28px 4px 28px;">${chips}</td></tr>` : "") +
    revisionHtml +
    section("Proposer", proposer) +
    (joint ? section("Spouse (joint life)", spouse) : "") +
    section("Cover requested", coverRows.join("")) +
    section("Checks", checks) +
    flagsHtml +
    notesHtml +
    button +
    `<tr><td style="padding:16px 28px 24px 28px;font-size:12px;color:#98a2b3;">Full record: Insurance_Submissions tab in the survey Google Sheet.</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

function buildAlert(sub) {
  const a = sub.answers;
  const flags = sub.flags || [];
  const tags = flagTags(flags);
  const joint = a.coverType === "Joint Life";
  const revision = Number(a.revisionNumber) > 1 ? ` (revision ${a.revisionNumber} of ${a.revisionOf})` : "";

  const subject =
    `New PRULife survey ${sub.referenceNumber} – ${a.fullName}` + (tags.length ? ` [${tags.join(" | ")}]` : "") + (revision ? " [REVISED]" : "");

  const cover = [];
  cover.push(`Plan: ${a.plan}${a.plan === "Plan B" ? " (critical illness built in)" : ""}`);
  cover.push(`Cover type: ${a.coverType}`);
  cover.push(`Premium term: ${a.premiumTerm}`);
  cover.push(`Quote based on: ${a.calcMode === "Premium" ? "premium" : "cover amount"}`);
  cover.push(`Frequency: ${a.paymentFrequency}`);
  if (a.modalPremium !== undefined) cover.push(`Premium (incl. riders): ${kes(a.modalPremium)} ${String(a.paymentFrequency).toLowerCase()}`);
  if (a.sumAssured !== undefined) cover.push(`Sum assured: ${kes(a.sumAssured)}`);
  if (a.ciRider) cover.push(`Critical illness rider: ${a.ciRider}${a.ciAmount ? ` – ${kes(a.ciAmount)}` : ""}`);
  if (a.accidentRider) cover.push(`Accident rider: ${a.accidentRider}${a.accidentAmount ? ` – ${kes(a.accidentAmount)}` : ""}`);

  const text = [
    `A new PRULife survey has been completed${revision}.`,
    "",
    `Reference: ${sub.referenceNumber}`,
    `Submitted: ${sub.submittedAt}`,
    "",
    "PROPOSER",
    `Name: ${a.fullName}`,
    `WhatsApp: +${a.proposerWaId}`,
    `Email: ${a.email || "not given"}`,
    `Lead source: ${a.source || "Direct"}`,
    `Date of birth: ${formatDob(a.dateOfBirth)} (age ${a.ageAtSubmission})`,
    `Gender: ${a.gender}`,
    `Smoker: ${a.smoker}`,
    ...(joint
      ? [
          "",
          "SPOUSE (joint life)",
          `Date of birth: ${formatDob(a.spouseDob)} (age ${a.spouseAge})`,
          `Gender: ${a.spouseGender}`,
          `Smoker: ${a.spouseSmoker}`,
        ]
      : []),
    "",
    "COVER REQUESTED",
    ...cover,
    ...(a.estTaxRelief !== "" && a.estTaxRelief !== undefined ? [`Indicative annual tax relief: ${kes(a.estTaxRelief)}`] : []),
    "",
    "CHECKS",
    `Medical exam: ${a.medicalRequired}`,
    `Special clearance: ${a.specialClearance}`,
    ...(flags.length ? ["", "FLAGS", ...flags.map((f) => `- ${f}`)] : []),
    ...(a.notes ? ["", `Notes from client: ${a.notes}`] : []),
    "",
    "Reply to the client on WhatsApp: https://wa.me/" + a.proposerWaId,
    "Full record: Insurance_Submissions tab in the survey Google Sheet.",
  ].join("\n");

  // Short version for WhatsApp.
  const coverLine = a.sumAssured !== undefined ? `Cover ${kes(a.sumAssured)}` : `Premium ${kes(a.modalPremium)} ${String(a.paymentFrequency).toLowerCase()}`;
  const waText =
    `📩 New PRULife survey ${sub.referenceNumber}${revision}\n` +
    `${a.fullName}, +${a.proposerWaId}\n` +
    `${a.plan}, ${a.coverType}, ${coverLine}\n` +
    `Source: ${a.source || "Direct"}\n` +
    (tags.length ? `⚠️ ${tags.join(", ")}\n` : "") +
    `Details sent to email / see Insurance_Submissions sheet.`;

  const html = buildHtml({ sub, a, flags, tags, joint, revision: Number(a.revisionNumber) > 1 });

  return { subject, text, html, waText, tags, templateParams: [sub.referenceNumber, a.fullName, `${a.plan}, ${coverLine}`, tags.length ? tags.join(", ") : "None"] };
}

async function sendEmail(alert) {
  const url = process.env.ALERT_WEBHOOK_URL;
  const to = process.env.ALERT_EMAIL_TO;
  const missing = [];
  if (!url) missing.push("ALERT_WEBHOOK_URL");
  if (!to) missing.push("ALERT_EMAIL_TO");
  if (missing.length) {
    console.warn(`Insurance alert email skipped: missing ${missing.join(" and ")}.`);
    return false;
  }
  const res = await axios.post(
    url,
    { secret: process.env.ALERT_WEBHOOK_SECRET || "", to, subject: alert.subject, body: alert.text, html: alert.html },
    { timeout: 15000, headers: { "Content-Type": "application/json" }, maxRedirects: 5 }
  );
  // Success means the relay explicitly answered {"ok":true}. Anything else —
  // including a Google sign-in/error WEB PAGE, which is what comes back when
  // the Apps Script deployment isn't set to "Anyone" or the URL is wrong —
  // is a failure. (An earlier version only rejected {"ok":false}, so a web
  // page was silently counted as sent.)
  let data = res.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (_) {
      /* not JSON */
    }
  }
  if (!data || typeof data !== "object") {
    const isPage = typeof res.data === "string" && /<html|<!doctype/i.test(res.data);
    throw new Error(
      isPage
        ? "Alert webhook returned a web page instead of JSON. In Apps Script: Deploy > Manage deployments, set 'Who has access' to Anyone, and use the URL ending in /exec."
        : "Alert webhook returned an unexpected response."
    );
  }
  if (data.ok !== true) throw new Error(`Alert webhook refused: ${data.error || "unknown error"}`);
  return true;
}

async function sendWhatsApp(alert) {
  const to = normalizeKenyanNumber(process.env.ALERT_WHATSAPP_TO);
  if (!to) {
    console.warn("Insurance alert WhatsApp skipped: ALERT_WHATSAPP_TO is not set.");
    return false;
  }
  try {
    await whatsapp.sendText(to, alert.waText);
    return true;
  } catch (err) {
    const code = err.response?.data?.error?.code;
    const template = process.env.ALERT_WA_TEMPLATE;
    // 131047 = outside the 24-hour window; a template is the only way through.
    if (code === 131047 && template) {
      await whatsapp.sendTemplate(to, template, process.env.ALERT_WA_TEMPLATE_LANG || "en", alert.templateParams);
      return true;
    }
    if (code === 131047) {
      console.warn("Insurance WhatsApp alert blocked (24-hour window) and no ALERT_WA_TEMPLATE is configured. Message the bot from the alert number to reopen the window, or set up a template.");
    }
    throw err;
  }
}

/**
 * Fires both channels; returns { email: bool, whatsapp: bool } and never throws.
 */
async function sendInsuranceAlert(sub) {
  const alert = buildAlert(sub);
  const result = { email: false, whatsapp: false };
  try {
    result.email = await sendEmail(alert);
  } catch (err) {
    console.error("Insurance alert (email) failed:", err.response?.data || err.message);
  }
  try {
    result.whatsapp = await sendWhatsApp(alert);
  } catch (err) {
    console.error("Insurance alert (WhatsApp) failed:", err.response?.data || err.message);
  }
  console.log(
    `Insurance alert for ${sub.referenceNumber}: email ${result.email ? "SENT" : "NOT sent"}, WhatsApp ${result.whatsapp ? "SENT" : "NOT sent"}`
  );
  return result;
}

// Logged once at startup so a misspelled or missing setting shows up in the
// Render logs immediately. Prints setting NAMES only, never their values.
function logAlertConfig() {
  const known = ["ALERT_EMAIL_TO", "ALERT_WEBHOOK_URL", "ALERT_WEBHOOK_SECRET", "ALERT_WHATSAPP_TO", "ALERT_WA_TEMPLATE", "ALERT_WA_TEMPLATE_LANG"];
  const isSet = (k) => !!(process.env[k] && process.env[k].trim());
  const emailMissing = ["ALERT_EMAIL_TO", "ALERT_WEBHOOK_URL", "ALERT_WEBHOOK_SECRET"].filter((k) => !isSet(k));
  console.log(
    `Insurance alerts - email: ${emailMissing.length ? `NOT configured (missing ${emailMissing.join(", ")})` : "configured"}; ` +
      `WhatsApp: ${isSet("ALERT_WHATSAPP_TO") ? "configured" : "NOT configured (missing ALERT_WHATSAPP_TO)"}`
  );
  const odd = Object.keys(process.env).filter((k) => /^ALERTS?[_-]/i.test(k) && !known.includes(k));
  if (odd.length) {
    console.warn(`Unrecognised alert setting name(s): ${odd.join(", ")} - check the spelling against: ${known.join(", ")}`);
  }
}
logAlertConfig();

module.exports = { sendInsuranceAlert, buildAlert, normalizeKenyanNumber, esc };
