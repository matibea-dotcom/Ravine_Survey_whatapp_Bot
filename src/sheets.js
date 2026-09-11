const { google } = require("googleapis");
const path = require("path");
const { getColumnsForTrack, getSheetTabForTrack } = require("./surveys");
const { RAVINE_SKU_LIST, RAVINE_SKU_TO_CATEGORY, COMPETITOR_BRANDS } = require("./surveys/mt");

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
  const ravinePricing = a.ravineSkuPricing || {};
  const ravineDetails = a.ravineSkuDetails || {};
  const competitorCategories = a.competitorCategories || {};
  const competitorPricing = a.competitorPricing || {};
  const photo = a.shelfPhoto || {};
  const WS_SUFFIX = " (WS/Carton)";
  const RETAIL_SUFFIX = " (Retail/Piece)";
  const FACINGS_SUFFIX = " Facings";
  const STOCK_STATUS_NOTE_SUFFIX = " Stock Status Note";
  const STOCK_STATUS_SUFFIX = " Stock Status";
  const CAT_SUFFIX = " Categories";
  const REG_PRICE_SUFFIX = " Regular Price";
  const PROMO_PRICE_SUFFIX = " Promo Price";

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
      case "Other Competitor Brands & Pricing": {
        // Catch-all for any ranked brand not in the fixed 7 (e.g. a typed
        // "Other" brand name) — the fixed 7 each get their own 3 columns
        // via the suffix handling below instead.
        const extras = Object.keys(competitorPricing).filter((b) => !COMPETITOR_BRANDS.includes(b));
        if (extras.length === 0) return "";
        return extras
          .map((b) => {
            const p = competitorPricing[b] || {};
            const cats = (competitorCategories[b] || []).join("/");
            return `${b} [${cats}]: Reg ${p.regular ?? "-"}, Promo ${p.promo ?? "-"}`;
          })
          .join("; ");
      }
      case "flags": return (submission.flags || []).join("; ");
      default: {
        if (col.endsWith(CAT_SUFFIX)) {
          const brand = col.slice(0, -CAT_SUFFIX.length);
          if (COMPETITOR_BRANDS.includes(brand)) return (competitorCategories[brand] || []).join(", ");
        }
        if (col.endsWith(REG_PRICE_SUFFIX)) {
          const brand = col.slice(0, -REG_PRICE_SUFFIX.length);
          if (COMPETITOR_BRANDS.includes(brand)) return competitorPricing[brand]?.regular ?? "";
        }
        if (col.endsWith(PROMO_PRICE_SUFFIX)) {
          const brand = col.slice(0, -PROMO_PRICE_SUFFIX.length);
          if (COMPETITOR_BRANDS.includes(brand)) return competitorPricing[brand]?.promo ?? "";
        }
        if (col.endsWith(WS_SUFFIX)) {
          const sku = col.slice(0, -WS_SUFFIX.length);
          const entry = ravinePricing[sku];
          if (entry) return entry.wsPerCarton ?? "";
        }
        if (col.endsWith(RETAIL_SUFFIX)) {
          const sku = col.slice(0, -RETAIL_SUFFIX.length);
          const entry = ravinePricing[sku];
          if (entry) return entry.retailPerPiece ?? "";
        }
        if (col.endsWith(FACINGS_SUFFIX)) {
          const sku = col.slice(0, -FACINGS_SUFFIX.length);
          const d = ravineDetails[sku];
          if (d) return d.facings ?? "";
        }
        if (col.endsWith(STOCK_STATUS_NOTE_SUFFIX)) {
          const sku = col.slice(0, -STOCK_STATUS_NOTE_SUFFIX.length);
          const d = ravineDetails[sku];
          if (d) return d.stockStatusNote ?? "";
        }
        if (col.endsWith(STOCK_STATUS_SUFFIX)) {
          const sku = col.slice(0, -STOCK_STATUS_SUFFIX.length);
          const d = ravineDetails[sku];
          if (d) return d.stockStatus ?? "";
        }
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

// ---- MT decision-support report (Phase 2.5) ----
// Computes the same headline KPIs as the manually-built Merch Dashboard
// (valid visits, % Ravine stocked, % out-of-stock, avg visibility, avg
// facings, % full planogram, % POS presence) directly from MT_Submissions,
// so REPORT can return them live instead of needing a hand-built dashboard.
// ---- Phase 4: "remember last visit" ----

/**
 * Returns the most recent MT_Submissions record for a given storeId, or null
 * if this store has no submissions yet. Records are raw flattened rows
 * (string values, as read from the sheet) — pass through unflattenMtSubmission
 * to get back the nested answers shape the survey engine works with.
 */
async function getLatestSubmissionForStore(storeId) {
  if (!storeId) return null;
  const tab = getSheetTabForTrack("MT");
  const { records } = await readAllRows(tab);
  const matches = records.filter((r) => r.storeId === storeId && r.submittedAt);
  if (matches.length === 0) return null;
  matches.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  return matches[0];
}

/**
 * Inverse of flattenSubmission for MT — reconstructs the nested `answers`
 * shape from a raw flattened sheet record, so a prior visit's data can be
 * reloaded as a starting point for a new one.
 *
 * Known lossy spots (documented, not bugs):
 * - "Other" competitor brands (typed names) are NOT reconstructed — too
 *   fragile to reliably parse back out of the free-text catch-all column.
 * - Competitor brand RANK ORDER is not preserved, only which brands had
 *   data and their categories/pricing (object key order is used as a
 *   best-effort stand-in, which usually matches insertion/column order).
 * - The photo is never carried over — always asked fresh on every visit.
 */
function unflattenMtSubmission(record) {
  const a = {};

  const IDENTITY_FIELDS = ["accountName", "storeType", "contactName", "contactNumber", "areaLocation"];
  for (const key of IDENTITY_FIELDS) {
    if (record[key]) a[key] = record[key];
  }
  if (record.gpsLat || record.gpsLng || record.gpsAddress) {
    a.gpsLocation = {
      lat: record.gpsLat !== "" ? parseFloat(record.gpsLat) : null,
      lng: record.gpsLng !== "" ? parseFloat(record.gpsLng) : null,
      address: record.gpsAddress || null,
      source: record.gpsSource || "stored",
      capturedAt: new Date().toISOString(),
    };
  }

  const SIMPLE_FIELDS = [
    "digitalPathStatus", "digitalPathIssueNote", "pendingOrders", "ravineStocked",
    "shelfPosition", "priceVsCompetitor", "priceDifferenceAmount", "shelfVisibilityRating",
    "brandsNextToRavine", "otherDairyCategoriesNote", "planogramCompliance", "secondaryDisplay",
    "staffCanRecommend", "issuesObserved", "merchandisingOpportunities", "paymentStatus",
    "outstandingBalance", "writtenCommitmentObtained", "shortExpiryPresent", "shortExpiryAction",
    "additionalRecommendations",
  ];
  for (const key of SIMPLE_FIELDS) {
    if (record[key] !== undefined && record[key] !== "") a[key] = record[key];
  }
  if (record.posMaterialsPresent) a.posMaterialsPresent = record.posMaterialsPresent.split(", ").filter(Boolean);

  // Per-SKU Ravine pricing/facings/stock status -> also derive
  // skusStocked + ravineCategoriesStocked from whichever SKUs have data.
  const ravineSkuPricing = {};
  const ravineSkuDetails = {};
  const skusStocked = [];
  const categoriesStocked = new Set();
  for (const entry of RAVINE_SKU_LIST) {
    const ws = record[`${entry.sku} (WS/Carton)`];
    const retail = record[`${entry.sku} (Retail/Piece)`];
    const facings = record[`${entry.sku} Facings`];
    const stockStatus = record[`${entry.sku} Stock Status`];
    const stockStatusNote = record[`${entry.sku} Stock Status Note`];
    if (!stockStatus && !ws && !retail && !facings) continue; // this SKU wasn't part of that visit
    skusStocked.push(entry.sku);
    categoriesStocked.add(RAVINE_SKU_TO_CATEGORY[entry.sku]);
    if (ws || retail) {
      ravineSkuPricing[entry.sku] = {
        wsPerCarton: ws !== "" ? Number(ws) : null,
        retailPerPiece: retail !== "" ? Number(retail) : null,
        source: "catalog",
      };
    }
    if (facings || stockStatus) {
      ravineSkuDetails[entry.sku] = {
        facings: facings !== "" ? Number(facings) : null,
        stockStatus: stockStatus || null,
        stockStatusNote: stockStatusNote || undefined,
      };
    }
  }
  if (skusStocked.length > 0) {
    a.skusStocked = skusStocked;
    a.ravineCategoriesStocked = [...categoriesStocked];
    a.ravineSkuPricing = ravineSkuPricing;
    a.ravineSkuDetails = ravineSkuDetails;
  }

  // Competitor brands (known 7 only — see doc comment above).
  const competitorCategories = {};
  const competitorPricing = {};
  const rankedBrands = [];
  for (const brand of COMPETITOR_BRANDS) {
    const cats = record[`${brand} Categories`];
    const regular = record[`${brand} Regular Price`];
    const promo = record[`${brand} Promo Price`];
    if (!cats && !regular) continue;
    rankedBrands.push(brand);
    if (cats) competitorCategories[brand] = cats.split(", ").filter(Boolean);
    competitorPricing[brand] = {
      regular: regular !== "" ? Number(regular) : null,
      promo: promo !== "" ? Number(promo) : null,
    };
  }
  if (rankedBrands.length > 0) {
    a.competitorBrandsRanked = rankedBrands;
    a.competitorCategories = competitorCategories;
    a.competitorPricing = competitorPricing;
  }

  return a;
}

// ---- Pricing dashboard (Ravine price index vs named-brand competitors) ----
// Computed per RAVINE_CATEGORIES (Long Life Milk/Yoghurt/Lala/Others) since
// individual SKU-to-competitor-product matching isn't reliable, but both
// Ravine's own catalog and competitor brands already share this category
// taxonomy — see mt.js.
// ---- Collections dashboard ----
// Total collected sums across ALL visits (money is cumulative over time).
// Outstanding balance and payment-status aging use only the MOST RECENT
// visit per store, since those represent current account state, not
// something that should be summed across repeat visits.
async function computeCollectionsReport() {
  const tab = getSheetTabForTrack("MT");
  const { records } = await readAllRows(tab);
  if (records.length === 0) return { totalVisits: 0 };

  let totalCollected = 0;
  for (const r of records) {
    const amt = Number(r.collectionAmount);
    if (!Number.isNaN(amt) && amt > 0) totalCollected += amt;
  }

  const latestByStore = new Map();
  for (const r of records) {
    if (!r.storeId || !r.submittedAt) continue;
    const existing = latestByStore.get(r.storeId);
    if (!existing || new Date(r.submittedAt) > new Date(existing.submittedAt)) {
      latestByStore.set(r.storeId, r);
    }
  }
  const snapshots = [...latestByStore.values()];

  let totalOutstanding = 0;
  let outstandingCount = 0;
  const aging = {
    "Current / Up to Date": 0,
    "Overdue (1-7 days)": 0,
    "Overdue (8-14 days)": 0,
    "Overdue (14+ days)": 0,
  };
  const overdueNoCommitment = [];

  for (const s of snapshots) {
    const bal = Number(s.outstandingBalance);
    if (!Number.isNaN(bal) && bal > 0) {
      totalOutstanding += bal;
      outstandingCount += 1;
    }
    if (s.paymentStatus && Object.prototype.hasOwnProperty.call(aging, s.paymentStatus)) {
      aging[s.paymentStatus] += 1;
    }
    const isOverdue = s.paymentStatus && s.paymentStatus !== "Current / Up to Date";
    if (isOverdue && s.writtenCommitmentObtained !== "Yes") {
      overdueNoCommitment.push({
        accountName: s.accountName,
        paymentStatus: s.paymentStatus,
        outstandingBalance: !Number.isNaN(bal) && bal > 0 ? bal : null,
      });
    }
  }

  return {
    totalVisits: records.length,
    accountsTracked: snapshots.length,
    totalCollected,
    totalOutstanding,
    outstandingCount,
    aging,
    overdueNoCommitment,
  };
}

async function computePricingReport() {
  const tab = getSheetTabForTrack("MT");
  const { records } = await readAllRows(tab);
  if (records.length === 0) return { totalVisits: 0 };

  const byCategory = {}; // category -> { ravinePrices: [], competitorPrices: [] }
  const ensureCat = (cat) => {
    if (!byCategory[cat]) byCategory[cat] = { ravinePrices: [], competitorPrices: [] };
    return byCategory[cat];
  };

  let promoObservations = 0;

  for (const r of records) {
    for (const entry of RAVINE_SKU_LIST) {
      const retail = r[`${entry.sku} (Retail/Piece)`];
      if (retail !== undefined && retail !== "") {
        const n = Number(retail);
        if (!Number.isNaN(n) && n > 0) {
          ensureCat(RAVINE_SKU_TO_CATEGORY[entry.sku]).ravinePrices.push(n);
        }
      }
    }
    for (const brand of COMPETITOR_BRANDS) {
      const regular = r[`${brand} Regular Price`];
      const promo = r[`${brand} Promo Price`];
      const cats = r[`${brand} Categories`];
      if (regular === undefined || regular === "" || !cats) continue;
      const regNum = Number(regular);
      if (Number.isNaN(regNum) || regNum <= 0) continue;
      const catList = cats.split(", ").filter(Boolean);
      for (const cat of catList) {
        ensureCat(cat).competitorPrices.push(regNum);
      }
      if (promo !== undefined && promo !== "" && !Number.isNaN(Number(promo)) && Number(promo) > 0) {
        promoObservations += 1;
      }
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const categories = Object.keys(byCategory)
    .map((cat) => {
      const ravineAvg = avg(byCategory[cat].ravinePrices);
      const competitorAvg = avg(byCategory[cat].competitorPrices);
      return {
        category: cat,
        ravineAvg,
        competitorAvg,
        priceIndex: ravineAvg != null && competitorAvg != null && competitorAvg > 0 ? ravineAvg / competitorAvg : null,
        ravineObservations: byCategory[cat].ravinePrices.length,
        competitorObservations: byCategory[cat].competitorPrices.length,
      };
    })
    .filter((c) => c.ravineObservations > 0 || c.competitorObservations > 0);

  const allRavinePrices = categories.flatMap((c) => byCategory[c.category].ravinePrices);
  const allCompetitorPrices = categories.flatMap((c) => byCategory[c.category].competitorPrices);
  const overallRavineAvg = avg(allRavinePrices);
  const overallCompetitorAvg = avg(allCompetitorPrices);

  return {
    totalVisits: records.length,
    overallRavineAvg,
    overallCompetitorAvg,
    overallPriceIndex:
      overallRavineAvg != null && overallCompetitorAvg != null && overallCompetitorAvg > 0
        ? overallRavineAvg / overallCompetitorAvg
        : null,
    promoObservations,
    categories,
  };
}

async function computeMtReport() {
  const tab = getSheetTabForTrack("MT");
  const { records } = await readAllRows(tab);
  const totalVisits = records.length;
  if (totalVisits === 0) return { totalVisits: 0 };

  const stockedYes = records.filter((r) => r.ravineStocked === "Yes").length;

  let oosCount = 0;
  let stockStatusTotal = 0;
  let facingsSum = 0;
  let facingsCount = 0;
  for (const r of records) {
    for (const entry of RAVINE_SKU_LIST) {
      const status = r[`${entry.sku} Stock Status`];
      if (status) {
        stockStatusTotal += 1;
        if (status === "Out of Stock") oosCount += 1;
      }
      const facingsVal = r[`${entry.sku} Facings`];
      if (facingsVal !== undefined && facingsVal !== "") {
        const n = Number(facingsVal);
        if (!Number.isNaN(n)) {
          facingsSum += n;
          facingsCount += 1;
        }
      }
    }
  }

  const visibilityValues = records
    .map((r) => Number(r.shelfVisibilityRating))
    .filter((n) => !Number.isNaN(n) && n > 0);

  const planogramAnswered = records.filter((r) => r.planogramCompliance);
  const planogramYes = planogramAnswered.filter((r) => r.planogramCompliance === "Yes").length;

  const posAnswered = records.filter((r) => r.posMaterialsPresent);
  const posPresent = posAnswered.filter((r) => r.posMaterialsPresent && r.posMaterialsPresent !== "None").length;

  return {
    totalVisits,
    stockedYes,
    stockedPct: totalVisits ? stockedYes / totalVisits : null,
    oosPct: stockStatusTotal ? oosCount / stockStatusTotal : null,
    avgVisibility: visibilityValues.length
      ? visibilityValues.reduce((a, b) => a + b, 0) / visibilityValues.length
      : null,
    avgFacings: facingsCount ? facingsSum / facingsCount : null,
    planogramPct: planogramAnswered.length ? planogramYes / planogramAnswered.length : null,
    posPct: posAnswered.length ? posPresent / posAnswered.length : null,
  };
}

module.exports = {
  readAllAgents,
  appendAgent,
  updateAgentRow,
  deleteAgent,
  appendSubmission,
  readAllStores,
  appendStore,
  computeMtReport,
  computePricingReport,
  computeCollectionsReport,
  getLatestSubmissionForStore,
  unflattenMtSubmission,
};
