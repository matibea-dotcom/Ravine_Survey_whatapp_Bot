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
    (tags.length ? `⚠️ ${tags.join(", ")}\n` : "") +
    `Details sent to email / see Insurance_Submissions sheet.`;

  return { subject, text, waText, tags, templateParams: [sub.referenceNumber, a.fullName, `${a.plan}, ${coverLine}`, tags.length ? tags.join(", ") : "None"] };
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
    { secret: process.env.ALERT_WEBHOOK_SECRET || "", to, subject: alert.subject, body: alert.text },
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

module.exports = { sendInsuranceAlert, buildAlert, normalizeKenyanNumber };
