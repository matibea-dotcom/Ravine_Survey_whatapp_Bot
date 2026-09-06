// GT (General Trade) survey — reconstructed to match the real column headers
// from your live Submissions tab. Wording/options for soldInStatus,
// notStockedReason, and stockOutFrequency are my best reconstruction since I
// didn't have the exact original prompts — tweak freely, the *keys* are what
// matter for the Sheets columns to line up.

const PRODUCT_X_NAME = process.env.PRODUCT_X_NAME || "Product X";

// These four are the SKU pricing columns visible in your sheet header.
const PRODUCT_X_SKUS = [
  "250ml Full Cream UHT",
  "500ml Full Cream UHT",
  "1L Full Cream UHT",
  "500ml Low Fat UHT",
];

const SOLD_IN_STATUS_OPTIONS = ["Sold In", "Not Stocked", "Discontinued"];
const STOCK_OUT_FREQUENCY_OPTIONS = ["Never", "Rarely", "Sometimes", "Often", "Always Out of Stock"];

const COMPETITOR_CATEGORIES = ["Category A", "Category B", "Category C", "Other"];
const COMPETITOR_PRODUCTS_BY_CATEGORY = {
  "Category A": ["Brand A1", "Brand A2", "Brand A3", "Brand A4", "Brand A5", "Other"],
  "Category B": ["Brand B1", "Brand B2", "Brand B3", "Brand B4", "Brand B5", "Other"],
  "Category C": ["Brand C1", "Brand C2", "Brand C3", "Brand C4", "Brand C5", "Other"],
  Other: ["Other"],
};

const MERCHANDISING_DISPLAY_TYPES = [
  "Shelf Display",
  "Floor Stand",
  "Fridge/Cooler Branding",
  "Wall Poster",
  "None",
];

const DELIVERY_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const SURVEY_STEPS = [
  {
    key: "retailerName",
    label: "Retailer Name",
    type: "text",
    required: true,
    prompt: "🏬 What is the *Retailer/Store Name*?",
    opts: { min: 2, max: 50 },
  },
  {
    key: "contactName",
    label: "Contact Person",
    type: "text",
    required: true,
    prompt: "Who is the *contact person* at this store?",
    opts: { min: 2, max: 50 },
  },
  {
    key: "contactNumber",
    label: "Contact Number",
    type: "phone",
    required: true,
    prompt: "What is their *contact number*? (e.g. +254712345678)",
  },
  {
    key: "gpsLocation",
    label: "GPS Location",
    type: "location",
    required: true,
    prompt: "📍 Please share the store's *location pin*, or type the address if you can't share a pin.",
  },
  {
    key: "soldInStatus",
    label: "Sold In Status",
    type: "select",
    required: true,
    prompt: `What is the *sold-in status* of ${PRODUCT_X_NAME} here?\n` + SOLD_IN_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SOLD_IN_STATUS_OPTIONS,
  },
  {
    key: "notStockedReason",
    label: "Reason Not Stocked",
    type: "comments",
    required: false,
    prompt: "Why isn't it currently stocked here? (or SKIP)",
    skipIf: (a) => a.soldInStatus === "Sold In",
  },
  {
    key: "willingToStock",
    label: "Willing to Stock",
    type: "select",
    required: false,
    prompt: "Would this store be *willing to stock* it going forward?\n1. Yes\n2. No",
    options: ["Yes", "No"],
    skipIf: (a) => a.soldInStatus === "Sold In",
  },
  {
    key: "productXSkusAvailable",
    label: "SKUs Available",
    type: "multiselect",
    required: false,
    prompt:
      `Which *${PRODUCT_X_NAME} SKUs* are available here? Reply with numbers, comma/space separated, or SKIP:\n` +
      PRODUCT_X_SKUS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: PRODUCT_X_SKUS,
    skipIf: (a) => a.soldInStatus !== "Sold In",
    // engine.js's SKU pricing loop triggers automatically off this exact key.
  },
  {
    key: "stockOutFrequency",
    label: "Stock-Out Frequency",
    type: "select",
    required: true,
    prompt:
      "How often does this store *run out of stock*?\n" +
      STOCK_OUT_FREQUENCY_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: STOCK_OUT_FREQUENCY_OPTIONS,
  },
  {
    key: "competitorCategory",
    label: "Competitor Category",
    type: "multiselect",
    required: false,
    prompt:
      "Which *competitor categories* are stocked here? Reply with numbers (e.g. 1,3) or SKIP:\n" +
      COMPETITOR_CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    options: COMPETITOR_CATEGORIES,
  },
  {
    key: "competitorProducts",
    label: "Competitor Products",
    type: "multiselect_dynamic",
    required: false,
    promptBuilder: (a) => {
      const cats = a.competitorCategory || [];
      const productSet = new Set();
      cats.forEach((c) => (COMPETITOR_PRODUCTS_BY_CATEGORY[c] || []).forEach((p) => productSet.add(p)));
      const options = [...productSet];
      return {
        options,
        prompt:
          "Which *competitor products* are stocked? Reply with numbers, comma or space separated:\n" +
          options.map((p, i) => `${i + 1}. ${p}`).join("\n"),
      };
    },
    skipIf: (a) => !a.competitorCategory || a.competitorCategory.length === 0,
  },
  {
    key: "competitorWsPrice",
    label: "Competitor W/S Price",
    type: "numeric",
    required: false,
    prompt: "What is the *competitor wholesale price*? (numbers only, or SKIP)",
    opts: { allowZero: false },
    skipIf: (a) => !a.competitorProducts || a.competitorProducts.length === 0,
  },
  {
    key: "competitorRrp",
    label: "Competitor RRP",
    type: "numeric",
    required: false,
    prompt: "What is the *competitor RRP*? (numbers only, or SKIP)",
    opts: { allowZero: false },
    skipIf: (a) => !a.competitorProducts || a.competitorProducts.length === 0,
    crossValidate: (value, a) => {
      if (a.competitorWsPrice != null && value < a.competitorWsPrice) {
        return { flagged: true, note: "Competitor RRP is lower than wholesale price — flagged for review." };
      }
      return { flagged: false };
    },
  },
  {
    key: "merchandisingOwn",
    label: "Merchandising (Own)",
    type: "select",
    required: true,
    prompt: "What *own-brand merchandising* is present?\n" + MERCHANDISING_DISPLAY_TYPES.map((d, i) => `${i + 1}. ${d}`).join("\n"),
    options: MERCHANDISING_DISPLAY_TYPES,
  },
  {
    key: "merchandisingCompetitor",
    label: "Merchandising (Competitor)",
    type: "multiselect",
    required: true,
    prompt:
      "What *competitor merchandising* is present? Reply with numbers, comma/space separated:\n" +
      MERCHANDISING_DISPLAY_TYPES.map((d, i) => `${i + 1}. ${d}`).join("\n"),
    options: MERCHANDISING_DISPLAY_TYPES,
  },
  {
    key: "distributorName",
    label: "Distributor Name",
    type: "text",
    required: true,
    prompt: "Who is the *distributor* supplying this store?",
    opts: { min: 2, max: 50 },
  },
  {
    key: "distributorAgentName",
    label: "Distributor Sales Agent Name",
    type: "text",
    required: true,
    prompt: "What is the *distributor's sales agent/salesman* name for this store?",
    opts: { min: 2, max: 50 },
  },
  {
    key: "deliveryDays",
    label: "Delivery Days",
    type: "multiselect",
    required: true,
    prompt:
      "Which *days* does this store receive delivery? Reply with numbers, comma/space separated, or NONE:\n" +
      DELIVERY_DAYS.map((d, i) => `${i + 1}. ${d}`).join("\n"),
    options: DELIVERY_DAYS,
    allowNone: true,
  },
  {
    key: "comments",
    label: "Comments",
    type: "comments",
    required: false,
    prompt: "Any *comments*? Competitor activity, promotions, trends, store feedback — max 500 characters, or SKIP.",
  },
];

// Column order — matches your live "Submissions" tab header exactly,
// including one WS/RRP pair per SKU (filled in by the SKU pricing loop).
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
  "soldInStatus",
  "notStockedReason",
  "willingToStock",
  "productXSkusAvailable",
  ...PRODUCT_X_SKUS.flatMap((sku) => [`${sku} WS`, `${sku} RRP`]),
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

module.exports = {
  label: "General Trade (GT)",
  sheetTabEnvVar: "GOOGLE_SHEET_TAB_GT",
  defaultSheetTab: "Submissions", // keeps writing to your existing tab — no migration needed
  SURVEY_STEPS,
  COLUMNS,
  PRODUCT_X_NAME,
  PRODUCT_X_SKUS,
  SOLD_IN_STATUS_OPTIONS,
  STOCK_OUT_FREQUENCY_OPTIONS,
  COMPETITOR_CATEGORIES,
  COMPETITOR_PRODUCTS_BY_CATEGORY,
  MERCHANDISING_DISPLAY_TYPES,
  DELIVERY_DAYS,
};
