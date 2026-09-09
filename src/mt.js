// MT (Modern Trade) survey — merged from two sources:
// 1. Ops/commercial fields built from the Ravine Dairies weekly reports
//    (Digital Path ordering status, collections/credit, short-expiry stock).
// 2. The full "Retail Store Audit, Pricing & Merchandising Survey" Google
//    Form (competitor category pricing, Ravine shelf presence, merchandising
//    execution, photo evidence).
//
// Photo capture is lightweight: records that a photo was sent, its WhatsApp
// media ID, MIME type, and caption — does not download/store the image
// itself. Build a Meta media-download + storage step separately if you want
// the actual files retained.

const PRODUCT_X_NAME = process.env.PRODUCT_X_NAME || "Ravine Dairy";

const PRODUCT_X_SKUS = [
  "250ml Full Cream UHT",
  "500ml Full Cream UHT",
  "1L Full Cream UHT",
  "500ml Low Fat UHT",
];

const STORE_TYPE_OPTIONS = ["Supermarket", "Mini-mart", "Kiosk/Duka", "Other"];
const DIGITAL_PATH_STATUS_OPTIONS = ["Active / Working", "Disabled / Closed", "Not Used at This Account"];
const SHELF_POSITION_OPTIONS = ["Eye Level", "Mid Shelf", "Bottom Shelf", "End Cap", "Chiller Front"];
const STOCK_STATUS_OPTIONS = ["Full", "Adequate", "Low", "Out of Stock", "Other"];
const PRICE_VS_COMPETITOR_OPTIONS = ["Cheaper", "Same", "More Expensive"];
const SHELF_VISIBILITY_OPTIONS = ["1", "2", "3", "4", "5"];
const POS_MATERIALS_OPTIONS = ["Shelf Talkers", "Place Cards", "Danglers", "Posters", "None"];
const PLANOGRAM_COMPLIANCE_OPTIONS = ["Yes", "Partial", "No"];
const SECONDARY_DISPLAY_OPTIONS = ["Island Display", "Chiller Branding", "End Cap", "Promo Bin", "None"];
const STAFF_RECOMMEND_OPTIONS = ["Yes", "No", "Maybe"];
const PAYMENT_STATUS_OPTIONS = [
  "Current / Up to Date",
  "Overdue (1-7 days)",
  "Overdue (8-14 days)",
  "Overdue (14+ days)",
];

// Competitor & category pricing — one prompt per category, matching the
// original form's "Brand – Regular Price – Promo Price, one per line"
// instruction. Vanilla 250ml is intentionally optional (matches the form).
const PRICING_CATEGORIES = [
  { key: "pricingEsl500ml", label: "ESL 500ml", required: true },
  { key: "pricingEsl200ml", label: "ESL 200ml", required: true },
  { key: "pricingFino500ml", label: "Fino 500ml", required: true },
  { key: "pricingLalaPouch500ml", label: "Lala Pouch 500ml", required: true },
  { key: "pricingLalaPouch200ml", label: "Lala Pouch 200ml", required: true },
  { key: "pricingLalaBottle", label: "Lala Bottle", required: true },
  { key: "pricingStrawberry500ml", label: "Strawberry 500ml", required: true },
  { key: "pricingStrawberry250ml", label: "Strawberry 250ml", required: true },
  { key: "pricingStrawberry150ml", label: "Strawberry 150ml", required: true },
  { key: "pricingStrawberry100ml", label: "Strawberry 100ml", required: true },
  { key: "pricingVanilla500ml", label: "Vanilla 500ml", required: true },
  { key: "pricingVanilla250ml", label: "Vanilla 250ml", required: false },
  { key: "pricingVanilla150ml", label: "Vanilla 150ml", required: true },
  { key: "pricingVanilla100ml", label: "Vanilla 100ml", required: true },
  { key: "pricingGhee", label: "Ghee", required: true },
  { key: "pricingCheese", label: "Cheese", required: true },
];

const pricingSteps = PRICING_CATEGORIES.map((cat, i) => ({
  key: cat.key,
  label: `${cat.label} – Brands & Prices`,
  type: "comments",
  required: cat.required,
  prompt:
    (i === 0
      ? "Now let's capture competitor pricing by category.\n\n" +
        "For each category, list every brand you see on the shelf using the format:\n" +
        "*Brand – Regular Price – Promotional Price (if any)*\n" +
        "One brand per line.\n\n"
      : "") + `*${cat.label} – Brands & Prices*${cat.required ? "" : " (optional, or SKIP)"}`,
}));

const SURVEY_STEPS = [
  {
    key: "accountName",
    label: "Store/Account Name",
    type: "text",
    required: true,
    prompt: "🏬 What is the *Store/Account Name*?",
    opts: { min: 2, max: 60 },
    skipIf: (a) => !!a.storeId,
  },
  {
    key: "storeType",
    label: "Store Type",
    type: "select",
    required: true,
    prompt: "What *type of store* is this?\n" + STORE_TYPE_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: STORE_TYPE_OPTIONS,
    skipIf: (a) => !!a.storeId,
  },
  {
    key: "contactName",
    label: "Contact Person",
    type: "text",
    required: true,
    prompt: "Who is the *contact person* at this account (buyer, store manager, or merchandising contact)?",
    opts: { min: 2, max: 50 },
    skipIf: (a) => !!a.storeId,
  },
  {
    key: "contactNumber",
    label: "Contact Number",
    type: "phone",
    required: false,
    prompt: "What is their *contact number*? (e.g. +254712345678, or SKIP)",
    skipIf: (a) => !!a.storeId,
  },
  {
    key: "areaLocation",
    label: "Area/Location",
    type: "text",
    required: true,
    prompt: "What *area/location* is this store in?",
    opts: { min: 2, max: 60 },
    skipIf: (a) => !!a.storeId,
  },
  {
    key: "gpsLocation",
    label: "GPS Location",
    type: "location",
    required: true,
    prompt: "📍 Please share the store's *location pin*, or type the address if you can't share a pin.",
    skipIf: (a) => !!a.storeId,
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
    prompt: "Briefly describe the *Digital Path issue* (e.g. account disabled due to overdue payment, naming mismatch, system glitch), or SKIP.",
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
    key: "ravineStocked",
    label: "Is Ravine Stocked",
    type: "select",
    required: true,
    prompt: `Is *${PRODUCT_X_NAME}* currently stocked at this store?\n1. Yes\n2. No`,
    options: ["Yes", "No"],
  },
  {
    key: "skusStocked",
    label: "SKUs Stocked",
    type: "multiselect",
    required: false,
    prompt:
      `Which *${PRODUCT_X_NAME} SKUs* are stocked? Reply with numbers, comma/space separated:\n` +
      PRODUCT_X_SKUS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: PRODUCT_X_SKUS,
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  {
    key: "shelfPosition",
    label: "Shelf Position",
    type: "select",
    required: true,
    prompt: "What is the *shelf position*?\n" + SHELF_POSITION_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SHELF_POSITION_OPTIONS,
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  {
    key: "numberOfFacings",
    label: "Number of Facings",
    type: "numeric",
    required: false,
    prompt: "How many *shelf facings* does the brand have here? (numbers only, or SKIP)",
    opts: { allowZero: true },
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  {
    key: "stockStatus",
    label: "Stock Status",
    type: "select",
    required: true,
    prompt: "What is the *stock status*?\n" + STOCK_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: STOCK_STATUS_OPTIONS,
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  {
    key: "stockStatusOtherNote",
    label: "Stock Status (Other) Detail",
    type: "comments",
    required: false,
    prompt: "You selected 'Other' for stock status — please describe it, or SKIP.",
    skipIf: (a) => a.stockStatus !== "Other",
  },
  {
    key: "priceVsCompetitor",
    label: "Price vs Nearest Competitor",
    type: "select",
    required: true,
    prompt: "How does Ravine's price compare to the *nearest competitor*?\n" + PRICE_VS_COMPETITOR_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: PRICE_VS_COMPETITOR_OPTIONS,
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  {
    key: "priceDifferenceAmount",
    label: "Price Difference Amount",
    type: "numeric",
    required: false,
    prompt: "If different, *by how much* (KES)? (numbers only, or SKIP)",
    opts: { allowZero: true },
    skipIf: (a) => a.ravineStocked !== "Yes" || a.priceVsCompetitor === "Same",
  },
  {
    key: "shelfVisibilityRating",
    label: "Shelf Visibility Rating",
    type: "select",
    required: true,
    prompt: "Rate the *shelf visibility* from 1 (poor) to 5 (excellent):\n" + SHELF_VISIBILITY_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SHELF_VISIBILITY_OPTIONS,
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  {
    key: "brandsNextToRavine",
    label: "Brands Shelved Next to Ravine",
    type: "text",
    required: false,
    prompt: "What *brands are shelved next to* Ravine? (or SKIP)",
    opts: { min: 1, max: 100, titleCase: false },
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  ...pricingSteps,
  {
    key: "otherDairyCategoriesNote",
    label: "Other Dairy Categories Present",
    type: "comments",
    required: false,
    prompt: "Any *other dairy categories present* on shelf not listed above? Or SKIP.",
  },
  {
    key: "posMaterialsPresent",
    label: "POS Materials Present",
    type: "multiselect",
    required: true,
    prompt:
      "What *POS materials* are present? Reply with numbers, comma/space separated:\n" +
      POS_MATERIALS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: POS_MATERIALS_OPTIONS,
  },
  {
    key: "planogramCompliance",
    label: "Planogram Compliance",
    type: "select",
    required: true,
    prompt: "Is the *planogram* being followed?\n" + PLANOGRAM_COMPLIANCE_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: PLANOGRAM_COMPLIANCE_OPTIONS,
  },
  {
    key: "secondaryDisplay",
    label: "Secondary Display",
    type: "select",
    required: true,
    prompt: "What *secondary display* is present?\n" + SECONDARY_DISPLAY_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SECONDARY_DISPLAY_OPTIONS,
  },
  {
    key: "staffCanRecommend",
    label: "Can Store Staff Recommend Ravine",
    type: "select",
    required: true,
    prompt: "Can *store staff recommend* Ravine to customers?\n" + STAFF_RECOMMEND_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: STAFF_RECOMMEND_OPTIONS,
  },
  {
    key: "issuesObserved",
    label: "Issues Observed",
    type: "comments",
    required: true,
    prompt: "Any *issues observed*? Examples: expired stock, poor rotation, damaged packs, missing price tags.",
  },
  {
    key: "merchandisingOpportunities",
    label: "Merchandising Opportunities",
    type: "comments",
    required: true,
    prompt: "Any *merchandising opportunities* you noticed?",
  },
  {
    key: "shelfPhoto",
    label: "Shelf/Chiller Photo",
    type: "photo",
    required: true,
    prompt: "📷 Please send a *photo of the dairy shelf/chiller* (attach via the 📎 icon > Camera/Gallery).",
  },
  {
    key: "paymentStatus",
    label: "Account Payment Status",
    type: "select",
    required: true,
    prompt: "What is this account's *payment status*?\n" + PAYMENT_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: PAYMENT_STATUS_OPTIONS,
    crossValidate: (value) => {
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
    key: "additionalRecommendations",
    label: "Additional Recommendations",
    type: "comments",
    required: true,
    prompt: "Any *additional recommendations*?",
  },
];

const COLUMNS = [
  "referenceNumber",
  "submittedAt",
  "sessionId",
  "agentWaId",
  "agentFullName",
  "agentId",
  "agentRegion",
  "agentCompany",
  "storeId",
  "accountName",
  "storeType",
  "contactName",
  "contactNumber",
  "areaLocation",
  "gpsLat",
  "gpsLng",
  "gpsAddress",
  "gpsSource",
  "digitalPathStatus",
  "digitalPathIssueNote",
  "pendingOrders",
  "ravineStocked",
  "skusStocked",
  "shelfPosition",
  "numberOfFacings",
  "stockStatus",
  "stockStatusOtherNote",
  "priceVsCompetitor",
  "priceDifferenceAmount",
  "shelfVisibilityRating",
  "brandsNextToRavine",
  ...PRICING_CATEGORIES.map((c) => c.key),
  "otherDairyCategoriesNote",
  "posMaterialsPresent",
  "planogramCompliance",
  "secondaryDisplay",
  "staffCanRecommend",
  "issuesObserved",
  "merchandisingOpportunities",
  "shelfPhotoReceived",
  "shelfPhotoMediaId",
  "shelfPhotoMimeType",
  "shelfPhotoCaption",
  "paymentStatus",
  "collectionAmount",
  "writtenCommitmentObtained",
  "shortExpiryPresent",
  "shortExpiryAction",
  "additionalRecommendations",
  "flags",
];

module.exports = {
  label: "Modern Trade (MT)",
  sheetTabEnvVar: "GOOGLE_SHEET_TAB_MT",
  defaultSheetTab: "MT_Submissions",
  SURVEY_STEPS,
  COLUMNS,
  PRODUCT_X_NAME,
  PRODUCT_X_SKUS,
  STORE_TYPE_OPTIONS,
  DIGITAL_PATH_STATUS_OPTIONS,
  SHELF_POSITION_OPTIONS,
  STOCK_STATUS_OPTIONS,
  PRICE_VS_COMPETITOR_OPTIONS,
  POS_MATERIALS_OPTIONS,
  PLANOGRAM_COMPLIANCE_OPTIONS,
  SECONDARY_DISPLAY_OPTIONS,
  STAFF_RECOMMEND_OPTIONS,
  PAYMENT_STATUS_OPTIONS,
  PRICING_CATEGORIES,
};
