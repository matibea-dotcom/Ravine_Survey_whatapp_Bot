// MT (Modern Trade) survey — built from the recurring issues raised in the
// GT weekly reports, MT weekly status reports, field report, and consultancy
// close-out: product availability/stockouts, Digital Path ordering-account
// status, collections/credit discipline, merchandising execution,
// competitor shelf pressure, and short-expiry stock management.

const PRODUCT_X_NAME = process.env.PRODUCT_X_NAME || "Product X";

const STOCK_STATUS_OPTIONS = ["Fully Stocked", "Partially Stocked", "Out of Stock (OOS)"];

const DIGITAL_PATH_STATUS_OPTIONS = ["Active / Working", "Disabled / Closed", "Not Used at This Account"];

const MERCHANDISING_DISPLAY_TYPES = [
  "Shelf Display",
  "Floor Stand",
  "Fridge/Cooler Branding",
  "Wall Poster",
  "Extension Cooler",
  "None",
];

const PAYMENT_STATUS_OPTIONS = [
  "Current / Up to Date",
  "Overdue (1-7 days)",
  "Overdue (8-14 days)",
  "Overdue (14+ days)",
];

const SURVEY_STEPS = [
  {
    key: "accountName",
    label: "MT Account/Outlet Name",
    type: "text",
    required: true,
    prompt: "🏬 What is the *Modern Trade account/outlet name*? (e.g. Chandarana Ridgeways, Naivas Kilimani)",
    opts: { min: 2, max: 60 },
  },
  {
    key: "contactName",
    label: "Contact Person",
    type: "text",
    required: true,
    prompt: "Who is the *contact person* at this account (buyer, store manager, or merchandising contact)?",
    opts: { min: 2, max: 50 },
  },
  {
    key: "contactNumber",
    label: "Contact Number",
    type: "phone",
    required: false,
    prompt: "What is their *contact number*? (e.g. +254712345678, or SKIP)",
  },
  {
    key: "gpsLocation",
    label: "GPS Location",
    type: "location",
    required: true,
    prompt: "📍 Please share the outlet's *location pin*, or type the branch/address if you can't share a pin.",
  },
  {
    key: "stockStatus",
    label: "Stock Availability",
    type: "select",
    required: true,
    prompt:
      "What is the current *stock availability* at this account?\n" +
      STOCK_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: STOCK_STATUS_OPTIONS,
  },
  {
    key: "oosSkus",
    label: "Out-of-Stock SKUs",
    type: "comments",
    required: false,
    prompt: `Which *${PRODUCT_X_NAME} SKUs* are out of stock or low? List them, or SKIP.`,
    skipIf: (a) => a.stockStatus === "Fully Stocked",
  },
  {
    key: "digitalPathStatus",
    label: "Digital Path Ordering Status",
    type: "select",
    required: true,
    prompt:
      "What is the status of this account's *Digital Path ordering account*?\n" +
      DIGITAL_PATH_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: DIGITAL_PATH_STATUS_OPTIONS,
  },
  {
    key: "digitalPathIssueNote",
    label: "Digital Path Issue Detail",
    type: "comments",
    required: false,
    prompt:
      "Briefly describe the *Digital Path issue* (e.g. account disabled due to overdue payment, naming mismatch, system glitch), or SKIP.",
    skipIf: (a) => a.digitalPathStatus === "Active / Working",
  },
  {
    key: "pendingOrders",
    label: "Pending Orders Awaiting Fulfilment",
    type: "select",
    required: true,
    prompt: "Are there *pending orders* at this account awaiting fulfilment (due to stock or system issues)?\n1. Yes\n2. No",
    options: ["Yes", "No"],
  },
  {
    key: "merchandisingOwn",
    label: "Merchandising (Own)",
    type: "select",
    required: true,
    prompt:
      "What *own-brand merchandising* is present?\n" +
      MERCHANDISING_DISPLAY_TYPES.map((d, i) => `${i + 1}. ${d}`).join("\n"),
    options: MERCHANDISING_DISPLAY_TYPES,
  },
  {
    key: "shelfFacings",
    label: "Shelf Facings Count",
    type: "numeric",
    required: false,
    prompt: "How many *shelf facings* does the brand currently have here? (numbers only, or SKIP)",
    opts: { allowZero: true },
  },
  {
    key: "competitorShelfGain",
    label: "Competitor Shelf Gain",
    type: "select",
    required: true,
    prompt: "Have competitors *gained shelf space* here recently?\n1. Yes\n2. No\n3. Not Sure",
    options: ["Yes", "No", "Not Sure"],
  },
  {
    key: "competitorActivityNote",
    label: "Competitor Activity Note",
    type: "comments",
    required: false,
    prompt: "Any details on *competitor activity* — new listings, promotions, pricing moves? Or SKIP.",
    skipIf: (a) => a.competitorShelfGain === "No",
  },
  {
    key: "paymentStatus",
    label: "Account Payment Status",
    type: "select",
    required: true,
    prompt:
      "What is this account's *payment status*?\n" +
      PAYMENT_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: PAYMENT_STATUS_OPTIONS,
    crossValidate: (value, a) => {
      if (value !== "Current / Up to Date") {
        return { flagged: true, note: "Overdue account — flagged for collections follow-up." };
      }
      return { flagged: false };
    },
  },
  {
    key: "collectionAmount",
    label: "Collection Amount Today (KES)",
    type: "numeric",
    required: false,
    prompt: "What *amount was collected* today, if any? (numbers only, or SKIP)",
    opts: { allowZero: true },
  },
  {
    key: "writtenCommitmentObtained",
    label: "Written Payment Commitment Obtained",
    type: "select",
    required: false,
    prompt: "Was a *written payment commitment* obtained from this account?\n1. Yes\n2. No",
    options: ["Yes", "No"],
    skipIf: (a) => a.paymentStatus === "Current / Up to Date",
  },
  {
    key: "shortExpiryPresent",
    label: "Short-Expiry Stock Present",
    type: "select",
    required: true,
    prompt: "Is there *short-expiry stock* at this account that needs action?\n1. Yes\n2. No",
    options: ["Yes", "No"],
  },
  {
    key: "shortExpiryAction",
    label: "Short-Expiry Action Taken",
    type: "comments",
    required: false,
    prompt: "What *action* was taken or is needed for the short-expiry stock (transfer, clearance deal, FIFO push)? Or SKIP.",
    skipIf: (a) => a.shortExpiryPresent !== "Yes",
  },
  {
    key: "comments",
    label: "Comments",
    type: "comments",
    required: false,
    prompt:
      "Any other *comments*? Handover status, system access issues, customer feedback — max 500 characters, or SKIP.",
  },
];

// Column order for the MT Google Sheet tab.
const COLUMNS = [
  "referenceNumber",
  "submittedAt",
  "sessionId",
  "agentWaId",
  "agentFullName",
  "agentId",
  "agentRegion",
  "agentCompany",
  "accountName",
  "contactName",
  "contactNumber",
  "gpsLat",
  "gpsLng",
  "gpsAddress",
  "gpsSource",
  "stockStatus",
  "oosSkus",
  "digitalPathStatus",
  "digitalPathIssueNote",
  "pendingOrders",
  "merchandisingOwn",
  "shelfFacings",
  "competitorShelfGain",
  "competitorActivityNote",
  "paymentStatus",
  "collectionAmount",
  "writtenCommitmentObtained",
  "shortExpiryPresent",
  "shortExpiryAction",
  "comments",
  "flags",
];

module.exports = {
  label: "Modern Trade (MT)",
  sheetTabEnvVar: "GOOGLE_SHEET_TAB_MT",
  defaultSheetTab: "MT_Submissions",
  SURVEY_STEPS,
  COLUMNS,
  STOCK_STATUS_OPTIONS,
  DIGITAL_PATH_STATUS_OPTIONS,
  MERCHANDISING_DISPLAY_TYPES,
  PAYMENT_STATUS_OPTIONS,
};
