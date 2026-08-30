const { google } = require("googleapis");
const path = require("path");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Submissions";
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "./service-account.json";

let sheetsClient = null;

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

// Column order — keep this in sync with the header row you create in the sheet.
const COLUMNS = [
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
  "productXAvailable",
  "productXWsPrice",
  "productXRrp",
  "competitorCategory",
  "competitorProducts",
  "competitorWsPrice",
  "competitorRrp",
  "merchandisingOwn",
  "merchandisingCompetitor",
  "distributorName",
  "distributorAgentName",
  "soldInStatus",
  "deliveryDays",
  "comments",
  "flags",
];

async function ensureHeader() {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:1`,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [COLUMNS] },
    });
  }
}

function flattenSubmission(submission) {
  const a = submission.answers;
  const gps = a.gpsLocation || {};
  return COLUMNS.map((col) => {
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
      case "competitorCategory": return (a.competitorCategory || []).join(", ");
      case "competitorProducts": return (a.competitorProducts || []).join(", ");
      case "merchandisingCompetitor": return (a.merchandisingCompetitor || []).join(", ");
      case "deliveryDays": return (a.deliveryDays || []).join(", ");
      case "flags": return (submission.flags || []).join("; ");
      default: return a[col] ?? "";
    }
  });
}

async function appendSubmission(submission) {
  const sheets = await getClient();
  await ensureHeader();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [flattenSubmission(submission)] },
  });
}

module.exports = { appendSubmission, COLUMNS };
