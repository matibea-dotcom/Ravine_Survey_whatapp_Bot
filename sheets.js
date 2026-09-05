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
// ---- Paste this into sheets.js, and add `deleteAgent` to its module.exports ----
// Assumes: (1) a Google auth client is already available in this file (reuse
// your existing getClient()/getSheetsClient() if one exists instead of the
// standalone one below), (2) GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE
// env vars are already set (same ones your other sheet functions use),
// (3) the Agents tab's header row has a column literally named "waId".
// If any of those differ in your actual file, this needs a small tweak —
// send me the real column headers / getClient name and I'll adjust.

const AGENTS_TAB = process.env.GOOGLE_SHEET_TAB_AGENTS || "Agents";

/**
 * Removes the row for a given waId from the Agents tab.
 * Returns true if a row was found and removed, OR if no matching row
 * existed (nothing to do = also success). Throws only on a real API/config
 * problem, which agentStore.clearAgent already catches and reports.
 */
async function deleteAgent(waId) {
  // If this file already has a shared client getter (e.g. getClient()),
  // replace the next 5 lines with: const sheetsApi = await getClient();
  const { google } = require("googleapis");
  const path = require("path");
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "./service-account.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  const sheetsApi = google.sheets({ version: "v4", auth: authClient });

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  // 1. Read the Agents tab to find which row holds this waId.
  const { data } = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${AGENTS_TAB}!A1:Z`,
  });
  const rows = data.values || [];
  if (rows.length === 0) return true; // tab is empty — nothing to delete

  const header = rows[0];
  const waIdCol = header.indexOf("waId");
  if (waIdCol === -1) {
    throw new Error(
      `"waId" column not found in ${AGENTS_TAB} header row. Actual headers: ${header.join(", ")}`
    );
  }

  const rowIndex = rows.findIndex((r, i) => i > 0 && r[waIdCol] === waId);
  if (rowIndex === -1) return true; // already gone — nothing to do

  // 2. Look up the tab's numeric sheetId (batchUpdate needs this, not the tab name).
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const tab = meta.data.sheets.find((s) => s.properties.title === AGENTS_TAB);
  if (!tab) {
    throw new Error(`Tab "${AGENTS_TAB}" not found in spreadsheet.`);
  }
  const sheetId = tab.properties.sheetId;

  // 3. Delete that row. rowIndex from the array above already lines up with
  // the 0-indexed grid position (rows[0] = header = grid row 0), so no +/-1
  // adjustment is needed beyond what's here.
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        },
      ],
    },
  });

  return true;
}

// Add deleteAgent to whatever module.exports object already exists in this
// file, e.g.:
// module.exports = { ...existingExports, deleteAgent };
