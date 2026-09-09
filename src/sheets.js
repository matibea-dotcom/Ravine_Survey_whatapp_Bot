const { google } = require("googleapis");
const path = require("path");
const { getColumnsForTrack, getSheetTabForTrack } = require("./surveys");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "./service-account.json";
const AGENTS_TAB = process.env.GOOGLE_SHEET_TAB_AGENTS || "Agents";
const STORES_TAB = process.env.GOOGLE_SHEET_TAB_STORES || "Stores";

const STORE_COLUMNS = [
  "storeId", "storeName", "storeType", "areaLocation",
  "gpsLat", "gpsLng", "gpsAddress", "gpsSource",
  "contactName", "contactNumber", "track",
  "createdAt", "createdByAgentWaId", "createdByAgentName",
];

// Base header for the Agents tab. "surveyTrack" is included here going
// forward; if your Agents tab predates this and doesn't have that column yet,
// ensureAgentsHeader() below adds it automatically on first write, without
// disturbing any existing rows/columns.
const AGENT_BASE_COLUMNS = ["waId", "fullName", "agentId", "region", "companyName", "surveyTrack", "registeredAt"];

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

function colLetter(index) {
  // 0-indexed column number -> A1-style column letter(s)
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

async function getSheetIdByTitle(title) {
  const sheetsApi = await getClient();
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tab = meta.data.sheets.find((s) => s.properties.title === title);
  return tab ? tab.properties.sheetId : null;
}

/**
 * Creates the tab if it doesn't already exist in the spreadsheet. Sheets API
 * throws "Unable to parse range" if you reference a tab name that isn't
 * there yet — this is called before every read/write so new tracks (e.g. a
 * brand-new MT_Submissions tab) get created automatically on first use
 * instead of crashing the submission.
 */
async function ensureTabExists(tabName) {
  const sheetId = await getSheetIdByTitle(tabName);
  if (sheetId !== null) return; // already exists
  const sheetsApi = await getClient();
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
}

// ---- Generic tab helpers (used by both Agents and Submissions tabs) ----

async function readHeader(tabName) {
  await ensureTabExists(tabName);
  const sheetsApi = await getClient();
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A1:ZZ1`,
  });
  return (res.data.values && res.data.values[0]) || [];
}

async function writeHeader(tabName, header) {
  const sheetsApi = await getClient();
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [header] },
  });
}

/**
 * Ensures the tab's header row contains every column in desiredCols, in
 * whatever order they already exist plus any missing ones appended at the
 * end. Returns the final header array. Safe to call before every write —
 * existing data/columns are never reordered or removed.
 */
async function ensureHeaderHasColumns(tabName, desiredCols) {
  await ensureTabExists(tabName);
  let header = await readHeader(tabName);
  const uniqueDesired = [...new Set(desiredCols)];
  if (header.length === 0) {
    header = uniqueDesired;
    await writeHeader(tabName, header);
    return header;
  }
  const missing = uniqueDesired.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    header = [...header, ...missing];
    await writeHeader(tabName, header);
  }
  return header;
}

async function readAllRows(tabName) {
  await ensureTabExists(tabName);
  const sheetsApi = await getClient();
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A1:ZZ`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0];
  const records = rows.slice(1).map((row) => {
    const obj = {};
    header.forEach((col, i) => (obj[col] = row[i] ?? ""));
    return obj;
  });
  return { header, records };
}

async function findRowIndexByColumn(tabName, columnName, value) {
  await ensureTabExists(tabName);
  const sheetsApi = await getClient();
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A1:ZZ`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return { rowIndex: -1, header: [] };
  const header = rows[0];
  const colIdx = header.indexOf(columnName);
  if (colIdx === -1) return { rowIndex: -1, header };
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[colIdx] === value);
  return { rowIndex, header };
}

async function deleteRow(tabName, rowIndex) {
  const sheetId = await getSheetIdByTitle(tabName);
  if (sheetId === null) throw new Error(`Tab "${tabName}" not found in spreadsheet.`);
  const sheetsApi = await getClient();
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 },
          },
        },
      ],
    },
  });
}

// ---- Agents tab ----

async function readAllAgents() {
  const { records } = await readAllRows(AGENTS_TAB);
  return records;
}

async function appendAgent(agent) {
  const header = await ensureHeaderHasColumns(AGENTS_TAB, [...AGENT_BASE_COLUMNS, ...Object.keys(agent)]);
  const row = header.map((col) => agent[col] ?? "");
  const sheetsApi = await getClient();
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${AGENTS_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

/**
 * Overwrites the entire row for updatedAgent.waId with its current field
 * values (used by agentStore.updateAgent, e.g. SWITCHTRACK/SETTRACK).
 */
async function updateAgentRow(updatedAgent) {
  const header = await ensureHeaderHasColumns(AGENTS_TAB, [...AGENT_BASE_COLUMNS, ...Object.keys(updatedAgent)]);
  const { rowIndex } = await findRowIndexByColumn(AGENTS_TAB, "waId", updatedAgent.waId);
  if (rowIndex === -1) throw new Error(`Agent ${updatedAgent.waId} not found in ${AGENTS_TAB}.`);
  const sheetRowNumber = rowIndex + 1; // rows[] is 0-indexed from A1; sheet rows are 1-indexed
  const row = header.map((col) => updatedAgent[col] ?? "");
  const sheetsApi = await getClient();
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${AGENTS_TAB}!A${sheetRowNumber}:${colLetter(header.length - 1)}${sheetRowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

/**
 * Removes the row for a given waId from the Agents tab. Returns without
 * error if no matching row exists (nothing to do = also success).
 */
async function deleteAgent(waId) {
  const { rowIndex, header } = await findRowIndexByColumn(AGENTS_TAB, "waId", waId);
  if (header.length === 0) return; // tab is empty — nothing to delete
  if (rowIndex === -1) return; // already gone
  await deleteRow(AGENTS_TAB, rowIndex);
}

// ---- Stores tab (Phase 1: registry so agents pick a known store instead of
// retyping it, and so future visits can look up the same store reliably) ----

async function readAllStores(track) {
  const { records } = await readAllRows(STORES_TAB);
  return track ? records.filter((r) => r.track === track) : records;
}

async function appendStore(store) {
  const header = await ensureHeaderHasColumns(STORES_TAB, STORE_COLUMNS);
  const row = header.map((col) => store[col] ?? "");
  const sheetsApi = await getClient();
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${STORES_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

// ---- Submissions tabs (one per track — GT/MT/Insurance) ----

// Fields with a fixed home (outside `answers`) or that need special
// flattening. Anything not listed here is read straight off
// `submission.answers[col]`, which covers every track's own fields, and SKU
// pricing columns (e.g. "250ml Full Cream UHT WS") pulled from the SKU loop.
function flattenSubmission(submission, columns) {
  const a = submission.answers;
  const gps = a.gpsLocation || {};
  const skuPricing = a.productXSkuPricing || {};
  const photo = a.shelfPhoto || {};

  return columns.map((col) => {
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
      case "shelfPhotoReceived": return photo.mediaId ? "Yes" : "No";
      case "shelfPhotoMediaId": return photo.mediaId ?? "";
      case "shelfPhotoMimeType": return photo.mimeType ?? "";
      case "shelfPhotoCaption": return photo.caption ?? "";
      case "flags": return (submission.flags || []).join("; ");
      default: {
        // SKU pricing columns look like "<SKU name> WS" / "<SKU name> RRP".
        if (col.endsWith(" WS") || col.endsWith(" RRP")) {
          const isWs = col.endsWith(" WS");
          const sku = col.slice(0, col.length - (isWs ? 3 : 4));
          const entry = skuPricing[sku];
          if (entry) return isWs ? entry.ws ?? "" : entry.rrp ?? "";
        }
        const value = a[col];
        if (Array.isArray(value)) return value.join(", ");
        return value ?? "";
      }
    }
  });
}

async function appendSubmission(submission) {
  const track = submission.track || "GT";
  const sheetTab = getSheetTabForTrack(track);
  const columns = getColumnsForTrack(track);

  await ensureHeaderHasColumns(sheetTab, columns);
  const sheetsApi = await getClient();
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTab}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [flattenSubmission(submission, columns)] },
  });
}

module.exports = {
  readAllAgents,
  appendAgent,
  updateAgentRow,
  deleteAgent,
  appendSubmission,
  readAllStores,
  appendStore,
};
