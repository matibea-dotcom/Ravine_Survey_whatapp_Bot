// Configurable lists — update these as the business requires (SOW 1.11, 1.16).
const PRODUCT_X_NAME = process.env.PRODUCT_X_NAME || "Product X";

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

const SOLD_IN_STATUS_OPTIONS = ["Sold In", "Seeding", "Not Stocked", "Discontinued"];

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

// ---- Main survey (SOW 1.8 validation table, 1.11-1.14) ----
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
    key: "productXAvailable",
    label: `${PRODUCT_X_NAME} Available`,
    type: "select",
    required: false,
    prompt: `Is *${PRODUCT_X_NAME}* available in this store?\n1. Yes\n2. No`,
    options: ["Yes", "No"],
  },
  {
    key: "productXWsPrice",
    label: `${PRODUCT_X_NAME} W/S Price`,
    type: "numeric",
    required: false,
    prompt: `What is the *wholesale price* of ${PRODUCT_X_NAME}? (numbers only, or SKIP)`,
    opts: { allowZero: false },
    skipIf: (a) => a.productXAvailable !== "Yes",
  },
  {
    key: "productXRrp",
    label: `${PRODUCT_X_NAME} RRP`,
    type: "numeric",
    required: false,
    prompt: `What is the *recommended retail price (RRP)* of ${PRODUCT_X_NAME}? (numbers only, or SKIP)`,
    opts: { allowZero: false },
    skipIf: (a) => a.productXAvailable !== "Yes",
    crossValidate: (value, a) => {
      if (a.productXWsPrice != null && value < a.productXWsPrice) {
        return { flagged: true, note: "RRP is lower than wholesale price — flagged for review." };
      }
      return { flagged: false };
    },
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
    // options resolved at runtime from selected categories
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
    prompt:
      "What *own-brand merchandising* is present?\n" +
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
    key: "soldInStatus",
    label: "Sold In Status",
    type: "select",
    required: true,
    prompt: "What is the *sold-in status*?\n" + SOLD_IN_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SOLD_IN_STATUS_OPTIONS,
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
  PRODUCT_X_NAME,
  COMPETITOR_CATEGORIES,
  COMPETITOR_PRODUCTS_BY_CATEGORY,
  MERCHANDISING_DISPLAY_TYPES,
  SOLD_IN_STATUS_OPTIONS,
  DELIVERY_DAYS,
};
