const { google } = require("googleapis");
const path = require("path");
const { getColumnsForTrack, getSheetTabForTrack } = require("./surveys");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
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

async function ensureHeader(sheetTab, columns) {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetTab}!A1:1`,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetTab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [columns] },
    });
  }
}

// Fields with a fixed home (outside `answers`) or that need special
// flattening (arrays, nested GPS object). Anything not listed here is read
// straight off `submission.answers[col]`, which covers every track's
// track-specific fields automatically.
function flattenSubmission(submission, columns) {
  const a = submission.answers;
  const gps = a.gpsLocation || {};
  return columns.map((col) => {
    switch (col) {
      case "referenceNumber": return submission.referenceNumber;
      case "submittedAt": return submission.submittedAt;
      case "sessionId": return submission.sessionId;
      case "surveyTrack": return submission.track;
      case "agentWaId": return submission.agent.waId;
      case "agentFullName": return submission.agent.fullName;
      case "agentId": return submission.agent.agentId;
      case "agentRegion": return submission.agent.region;
      case "agentCompany": return submission.agent.companyName;
      case "gpsLat": return gps.lat ?? "";
      case "gpsLng": return gps.lng ?? "";
      case "gpsAddress": return gps.address ?? "";
      case "gpsSource": return gps.source ?? "";
      case "flags": return (submission.flags || []).join("; ");
      default: {
        const value = a[col];
        if (Array.isArray(value)) return value.join(", ");
        return value ?? "";
      }
    }
  });
}

async function appendSubmission(submission) {
  try {
    const track = submission.track || "GT";
    const sheetTab = getSheetTabForTrack(track);
    const columns = getColumnsForTrack(track);

    const sheets = await getClient();
    await ensureHeader(sheetTab, columns);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${sheetTab}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [flattenSubmission(submission, columns)] },
    });
  } catch (err) {
    console.error(
      "Sheets append failed:",
      err.response?.data || err.stack || err
    );
    throw err; // preserve original behavior: engine.js catches this to warn the agent
  }
}

module.exports = { appendSubmission };
