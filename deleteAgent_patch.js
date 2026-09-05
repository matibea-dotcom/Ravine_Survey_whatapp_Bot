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
