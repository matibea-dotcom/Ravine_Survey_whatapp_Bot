const { google } = require("googleapis");
const path = require("path");
const { RAVINE_UHT_SKUS } = require("./survey");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SUBMISSIONS_TAB = process.env.GOOGLE_SHEET_TAB || "Submissions";
const AGENTS_TAB = process.env.GOOGLE_SHEET_AGENTS_TAB || "Agents";
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "./service-account.json";

let sheetsClient = null;
const ensuredTabs = new Set();

async function getClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(KEY_FILE),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: "v4", auth: authClient });
  return sheetsClient;
}

/** Creates the named tab if it doesn't already exist in the spreadsheet. */
async function ensureTabExists(tabName) {
  if (ensuredTabs.has(tabName)) return;
  const sheets = await getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
  ensuredTabs.add(tabName);
}

async function ensureHeader(tabName, columns) {
  await ensureTabExists(tabName);
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1:1`,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [columns] },
    });
  }
}

async function appendRow(tabName, columns, row) {
  await ensureHeader(tabName, columns);
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

/** Reads all data rows (excluding header) from a tab as arrays of cell values. */
async function readAllRows(tabName, columns) {
  await ensureHeader(tabName, columns);
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A2:ZZ`,
  });
  return res.data.values || [];
}

// ---- Submissions ----
// Ravine UHT SKUs get their own wholesale/RRP column pair each, since pricing
// is captured per-SKU (see engine.js SKU pricing loop).
const SKU_PRICE_COLUMNS = RAVINE_UHT_SKUS.flatMap((sku) => [`${sku} WS`, `${sku} RRP`]);

const SUBMISSION_COLUMNS = [
  "referenceNumber",
  "submittedAt",
  "sessionId",
  "agentWaId",
  "agentFullName",
  "agentId",
  "agentRegion",
  "agentCompany",
  "retailerName",
  "contactName",
  "contactNumber",
  "gpsLat",
  "gpsLng",
  "gpsAddress",
  "gpsSource",
  "soldInStatus",
  "notStockedReason",
  "willingToStock",
  "productXSkusAvailable",
  ...SKU_PRICE_COLUMNS,
  "stockOutFrequency",
  "competitorCategory",
  "competitorProducts",
  "competitorWsPrice",
  "competitorRrp",
  "merchandisingOwn",
  "merchandisingCompetitor",
  "distributorName",
  "distributorAgentName",
  "deliveryDays",
  "comments",
  "flags",
];

function flattenSubmission(submission) {
  const a = submission.answers;
  const gps = a.gpsLocation || {};
  const skuPricing = a.productXSkuPricing || {};
  return SUBMISSION_COLUMNS.map((col) => {
    if (col.endsWith(" WS") || col.endsWith(" RRP")) {
      const isWs = col.endsWith(" WS");
      const sku = col.slice(0, col.length - (isWs ? 3 : 4));
      const entry = skuPricing[sku];
      if (!entry) return "";
      return isWs ? entry.ws ?? "" : entry.rrp ?? "";
    }
    switch (col) {
      case "referenceNumber": return submission.referenceNumber;
      case "submittedAt": return submission.submittedAt;
      case "sessionId": return submission.sessionId;
      case "agentWaId": return submission.agent.waId;
      case "agentFullName": return submission.agent.fullName;
      case "agentId": return submission.agent.agentId;
      case "agentRegion": return submission.agent.region;
      case "agentCompany": return submission.agent.companyName;
      case "gpsLat": return gps.lat ?? "";
      case "gpsLng": return gps.lng ?? "";
      case "gpsAddress": return gps.address ?? "";
      case "gpsSource": return gps.source ?? "";
      case "productXSkusAvailable": return (a.productXSkusAvailable || []).join(", ");
      case "competitorCategory": return (a.competitorCategory || []).join(", ");
      case "competitorProducts": return (a.competitorProducts || []).join(", ");
      case "merchandisingOwn": return (a.merchandisingOwn || []).join(", ");
      case "merchandisingCompetitor": return (a.merchandisingCompetitor || []).join(", ");
      case "deliveryDays": return (a.deliveryDays || []).join(", ");
      case "flags": return (submission.flags || []).join("; ");
      default: return a[col] ?? "";
    }
  });
}

async function appendSubmission(submission) {
  await appendRow(SUBMISSIONS_TAB, SUBMISSION_COLUMNS, flattenSubmission(submission));
}

// ---- Agents (registration registry — durable across redeploys) ----
const AGENT_COLUMNS = ["waId", "fullName", "agentId", "region", "companyName", "registeredAt"];

async function appendAgent(agent) {
  await appendRow(
    AGENTS_TAB,
    AGENT_COLUMNS,
    AGENT_COLUMNS.map((c) => agent[c] ?? "")
  );
}

async function readAllAgents() {
  const rows = await readAllRows(AGENTS_TAB, AGENT_COLUMNS);
  return rows
    .filter((row) => row[0]) // skip blank rows
    .map((row) => {
      const agent = {};
      AGENT_COLUMNS.forEach((col, i) => (agent[col] = row[i] ?? ""));
      return agent;
    });
}

module.exports = {
  appendSubmission,
  appendAgent,
  readAllAgents,
  SUBMISSION_COLUMNS,
  AGENT_COLUMNS,
};
