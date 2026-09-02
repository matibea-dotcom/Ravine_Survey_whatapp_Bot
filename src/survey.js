// ---- Ravine Dairies configuration ----
// Edit these lists directly as SKUs, competitors, or campaigns change.
// (Sourced against current Kenyan dairy market structure — Brookside/Tuzo/Ilara/
// Molo Milk, New KCC, Githunguri's Fresha, Daima, Bio Foods, plus Nakuru-local
// Alpha Dairy — update as your own market intelligence updates.)

const RAVINE_BRAND_NAME = process.env.RAVINE_BRAND_NAME || "Ravine Dairies";

// The UHT SKUs Ravine Dairies sells — this is the core of the survey.
const RAVINE_UHT_SKUS = [
  "250ml Full Cream UHT",
  "500ml Full Cream UHT",
  "1L Full Cream UHT",
  "500ml Low Fat UHT",
];

const COMPETITOR_CATEGORIES = [
  "Fresh Pasteurized Milk",
  "UHT/Long-Life Milk",
  "Fermented Milk (Mala/Lala)",
  "Yoghurt",
  "Powdered Milk",
  "Butter & Ghee",
  "Cheese",
];

const COMPETITOR_PRODUCTS_BY_CATEGORY = {
  "Fresh Pasteurized Milk": ["Brookside", "Tuzo", "Ilara", "New KCC (Gold Crown/Farm Fresh)", "Fresha (Githunguri)", "Daima", "Alpha Dairy (Nakuru)", "Other"],
  "UHT/Long-Life Milk": ["Brookside UHT", "New KCC UHT", "Daima UHT", "Fresha UHT", "Other"],
  "Fermented Milk (Mala/Lala)": ["Brookside Lala", "New KCC Mala", "Fresha Mala", "Daima Mala", "Other"],
  "Yoghurt": ["Brookside Yoghurt", "Bio Foods Yoghurt", "New KCC Delite", "Daima Yoghurt", "Fresha Yoghurt", "Other"],
  "Powdered Milk": ["New KCC Powdered Milk", "Nido (Nestle)", "Other"],
  "Butter & Ghee": ["Brookside Butter/Ghee", "New KCC Butter/Ghee", "Zesta Ghee", "Other"],
  "Cheese": ["Brookside Cheese", "New KCC Cheese", "Other"],
};

// Trade marketing materials relevant to dairy retail — fridge branding matters
// a lot for milk specifically, alongside standard POS materials.
const MERCHANDISING_DISPLAY_TYPES = [
  "Fridge/Cooler Branding",
  "Posters",
  "Danglers",
  "Shelf Strip",
  "Branded Umbrella/Signage",
  "None",
];

const SOLD_IN_STATUS_OPTIONS = ["Sold In - Actively Stocked", "Seeding - Recently Introduced", "Not Stocked", "Discontinued"];

// Distribution-growth fields: for stores NOT stocking Ravine UHT, capture why —
// this is the actionable data for converting new outlets.
const NOT_STOCKED_REASONS = [
  "No demand from customers",
  "Distributor doesn't deliver here",
  "Price too high vs competitors",
  "Prefers competitor brand",
  "Never approached by a rep",
  "Limited shelf/fridge space",
  "Other",
];

const WILLINGNESS_TO_STOCK_OPTIONS = [
  "Yes - Interested, ready to order",
  "Maybe - Needs follow-up",
  "No - Not interested",
];

// For stores that DO stock Ravine UHT — supply reliability is a direct
// distribution-growth signal (a store that stocks out often is losing sales
// you could be capturing with better delivery frequency).
const STOCK_OUT_FREQUENCY_OPTIONS = [
  "Never runs out",
  "Occasionally (1-2x/month)",
  "Frequently (weekly)",
  "Almost always understocked",
];

const DELIVERY_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

// ---- Registration (SOW 1.4) — runs once per new WhatsApp number ----
const REGISTRATION_STEPS = [
  { key: "fullName", label: "Full Name", type: "text", prompt: "Welcome! Let's get you set up. What is your *full name*?" },
  { key: "agentId", label: "Employee/Agent ID", type: "text", prompt: "Thanks. What is your *Employee/Agent ID*?", opts: { max: 20, titleCase: false } },
  { key: "region", label: "Region/Territory", type: "text", prompt: "Which *region or territory* do you cover?" },
  { key: "companyName", label: "Company Name", type: "text", prompt: "Which *company* are you registering with?" },
];

// ---- Main survey ----
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
    prompt: `What is *${RAVINE_BRAND_NAME} UHT's* status in this store?\n` + SOLD_IN_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SOLD_IN_STATUS_OPTIONS,
  },
  // --- Branch: store DOES NOT currently stock Ravine UHT (distribution growth opportunity) ---
  {
    key: "notStockedReason",
    label: "Reason Not Stocked",
    type: "select",
    required: false,
    prompt: "Why isn't it currently stocked here?\n" + NOT_STOCKED_REASONS.map((r, i) => `${i + 1}. ${r}`).join("\n"),
    options: NOT_STOCKED_REASONS,
    skipIf: (a) => a.soldInStatus !== "Not Stocked" && a.soldInStatus !== "Discontinued",
  },
  {
    key: "willingToStock",
    label: "Willing to Stock",
    type: "select",
    required: false,
    prompt: "Would this store be willing to stock Ravine UHT if approached?\n" + WILLINGNESS_TO_STOCK_OPTIONS.map((w, i) => `${i + 1}. ${w}`).join("\n"),
    options: WILLINGNESS_TO_STOCK_OPTIONS,
    skipIf: (a) => a.soldInStatus !== "Not Stocked" && a.soldInStatus !== "Discontinued",
  },
  // --- Branch: store DOES stock Ravine UHT — capture which SKUs (per-SKU pricing
  // is captured via a dynamic loop in engine.js right after this step; see
  // engine.js `handleSkuPricingLoop`, since the number of price questions
  // depends on how many SKUs are selected here) ---
  {
    key: "productXSkusAvailable",
    label: "Ravine UHT SKUs Stocked",
    type: "multiselect",
    required: false,
    prompt:
      `Which *${RAVINE_BRAND_NAME} UHT SKUs* are stocked here? Reply with numbers, comma/space separated, or SKIP:\n` +
      RAVINE_UHT_SKUS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: RAVINE_UHT_SKUS,
    skipIf: (a) => a.soldInStatus === "Not Stocked" || a.soldInStatus === "Discontinued",
  },
  {
    key: "stockOutFrequency",
    label: "Stock-Out Frequency",
    type: "select",
    required: false,
    prompt: "How often does this store run out of Ravine UHT between deliveries?\n" + STOCK_OUT_FREQUENCY_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: STOCK_OUT_FREQUENCY_OPTIONS,
    skipIf: (a) => !a.productXSkusAvailable || a.productXSkusAvailable.length === 0,
  },
  // --- Competitive landscape ---
  {
    key: "competitorCategory",
    label: "Competitor Category",
    type: "multiselect",
    required: false,
    prompt:
      "Which *competitor dairy categories* are stocked here? Reply with numbers (e.g. 1,3) or SKIP:\n" +
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
          "Which *competitor brands* are stocked? Reply with numbers, comma or space separated:\n" +
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
    prompt: "What is the *competitor wholesale price* (representative SKU)? (numbers only, or SKIP)",
    opts: { allowZero: false },
    skipIf: (a) => !a.competitorProducts || a.competitorProducts.length === 0,
  },
  {
    key: "competitorRrp",
    label: "Competitor RRP",
    type: "numeric",
    required: false,
    prompt: "What is the *competitor RRP* (representative SKU)? (numbers only, or SKIP)",
    opts: { allowZero: false },
    skipIf: (a) => !a.competitorProducts || a.competitorProducts.length === 0,
    crossValidate: (value, a) => {
      if (a.competitorWsPrice != null && value < a.competitorWsPrice) {
        return { flagged: true, note: "Competitor RRP is lower than wholesale price — flagged for review." };
      }
      return { flagged: false };
    },
  },
  // --- Merchandising ---
  {
    key: "merchandisingOwn",
    label: "Merchandising (Ravine)",
    type: "multiselect",
    required: true,
    prompt:
      `What *${RAVINE_BRAND_NAME} branding/merchandising* is present? Reply with numbers, comma/space separated:\n` +
      MERCHANDISING_DISPLAY_TYPES.map((d, i) => `${i + 1}. ${d}`).join("\n"),
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
  // --- Distribution / trade info ---
  {
    key: "distributorName",
    label: "Distributor Name",
    type: "text",
    required: true,
    prompt: "Who is the *distributor* supplying this store (or who currently could)?",
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
    prompt:
      "Any *comments*? Competitor activity, promotions, trends, store feedback — max 500 characters, or SKIP.",
  },
];

module.exports = {
  REGISTRATION_STEPS,
  SURVEY_STEPS,
  RAVINE_BRAND_NAME,
  RAVINE_UHT_SKUS,
  COMPETITOR_CATEGORIES,
  COMPETITOR_PRODUCTS_BY_CATEGORY,
  MERCHANDISING_DISPLAY_TYPES,
  SOLD_IN_STATUS_OPTIONS,
  NOT_STOCKED_REASONS,
  WILLINGNESS_TO_STOCK_OPTIONS,
  STOCK_OUT_FREQUENCY_OPTIONS,
  DELIVERY_DAYS,
};
