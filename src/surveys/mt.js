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

// ---- Ravine product catalog (from the official price list appendix) ----
// Grouped by category so agents pick a category first, then specific SKUs
// within it, instead of scrolling one flat list of 19+ items.
const RAVINE_CATEGORIES = ["Long Life Milk", "Yoghurt", "Lala", "Others"];

const RAVINE_CATALOG = {
  "Long Life Milk": [
    { sku: "Fino 500ml", piecesPerCarton: 12, wsPerCarton: 660, wsPerPiece: 55, retailPerCarton: 720, retailPerPiece: 60 },
    { sku: "ESL 500ml", piecesPerCarton: 12, wsPerCarton: 624, wsPerPiece: 52, retailPerCarton: 696, retailPerPiece: 58 },
    { sku: "ESL 200ml", piecesPerCarton: 21, wsPerCarton: 525, wsPerPiece: 25, retailPerCarton: 588, retailPerPiece: 28 },
  ],
  Lala: [
    { sku: "Lala Pouch 500ml", piecesPerCarton: 18, wsPerCarton: 990, wsPerPiece: 55, retailPerCarton: 1260, retailPerPiece: 70 },
    { sku: "Lala Pouch 200ml", piecesPerCarton: 45, wsPerCarton: 900, wsPerPiece: 20, retailPerCarton: 1125, retailPerPiece: 25 },
    { sku: "Lala Bottle 500ml", piecesPerCarton: 12, wsPerCarton: 780, wsPerPiece: 65, retailPerCarton: 840, retailPerPiece: 75 },
  ],
  Yoghurt: [
    { sku: "Natural Yoghurt 500ml", piecesPerCarton: 6, wsPerCarton: 480, wsPerPiece: 80, retailPerCarton: 510, retailPerPiece: 85 },
    { sku: "Natural Yoghurt 250ml", piecesPerCarton: 12, wsPerCarton: 336, wsPerPiece: 28, retailPerCarton: 372, retailPerPiece: 31 },
    { sku: "Natural Yoghurt 150ml", piecesPerCarton: 12, wsPerCarton: 336, wsPerPiece: 28, retailPerCarton: 372, retailPerPiece: 31 },
    { sku: "Natural Yoghurt 100ml", piecesPerCarton: 12, wsPerCarton: 240, wsPerPiece: 20, retailPerCarton: 264, retailPerPiece: 22 },
    { sku: "Vanilla Yoghurt 500ml", piecesPerCarton: 6, wsPerCarton: 600, wsPerPiece: 100, retailPerCarton: 720, retailPerPiece: 120 },
    { sku: "Vanilla Yoghurt 250ml", piecesPerCarton: 12, wsPerCarton: 600, wsPerPiece: 50, retailPerCarton: 780, retailPerPiece: 65 },
    { sku: "Vanilla Yoghurt 150ml", piecesPerCarton: 12, wsPerCarton: 396, wsPerPiece: 33, retailPerCarton: 528, retailPerPiece: 44 },
    { sku: "Vanilla Yoghurt 100ml", piecesPerCarton: 12, wsPerCarton: 288, wsPerPiece: 24, retailPerCarton: 384, retailPerPiece: 32 },
    { sku: "Strawberry Yoghurt 500ml", piecesPerCarton: 6, wsPerCarton: 600, wsPerPiece: 100, retailPerCarton: 720, retailPerPiece: 120 },
    { sku: "Strawberry Yoghurt 250ml", piecesPerCarton: 12, wsPerCarton: 600, wsPerPiece: 50, retailPerCarton: 780, retailPerPiece: 65 },
    // NOTE: the source doc lists "Vanilla Yoghurt 150ml" twice and never lists
    // Strawberry 150ml explicitly — almost certainly a copy-paste typo for
    // "Strawberry Yoghurt 150ml". Using the Vanilla 150ml price as a
    // placeholder (matches the pattern where Strawberry mirrors Vanilla at
    // every other size) — please confirm/correct this one specifically.
    { sku: "Strawberry Yoghurt 150ml", piecesPerCarton: 12, wsPerCarton: 396, wsPerPiece: 33, retailPerCarton: 528, retailPerPiece: 44 },
    { sku: "Strawberry Yoghurt 100ml", piecesPerCarton: 12, wsPerCarton: 288, wsPerPiece: 24, retailPerCarton: 384, retailPerPiece: 32 },
  ],
  Others: [
    { sku: "Crate 20 Litres", piecesPerCarton: 1, wsPerCarton: 1500, wsPerPiece: 1500, retailPerCarton: 1500, retailPerPiece: 1500 },
    { sku: "Ghee 20kg", piecesPerCarton: 1, wsPerCarton: 13000, wsPerPiece: 650, retailPerCarton: 13000, retailPerPiece: 13000 },
    { sku: "Cream (per kg)", piecesPerCarton: 1, wsPerCarton: 350, wsPerPiece: 350, retailPerCarton: 350, retailPerPiece: 350 },
  ],
};

// Flat list + name->entry index, used for the pricing loop and Sheets columns.
const RAVINE_SKU_LIST = Object.values(RAVINE_CATALOG).flat();
const RAVINE_SKU_INDEX = Object.fromEntries(RAVINE_SKU_LIST.map((e) => [e.sku, e]));
// Reverse lookup (sku -> category name), used to reconstruct
// ravineCategoriesStocked when replaying a prior visit's answers (Phase 4).
const RAVINE_SKU_TO_CATEGORY = Object.fromEntries(
  Object.entries(RAVINE_CATALOG).flatMap(([cat, entries]) => entries.map((e) => [e.sku, cat]))
);

const STORE_TYPE_OPTIONS = ["Supermarket", "Mini-mart", "Kiosk/Duka", "Warehouse/HQ", "Other"];
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

// Competitor pricing (Phase 3) — agent ranks the competitor brands actually
// present by sales volume, then each ranked brand gets a category-presence
// checklist + one regular price + one promo price (see engine.js's
// competitorLoop). This trades category×brand pricing granularity for a
// much shorter, cleaner survey — full per-category competitor pricing would
// add 25+ more questions on top of an already-long flow.
const COMPETITOR_BRANDS = ["Brookside", "Fresha", "KCC", "Tuzo", "Ilara", "Delamere", "Daima"];
const COMPETITOR_BRAND_OPTIONS = [...COMPETITOR_BRANDS, "Other"];

const competitorSteps = [
  {
    key: "competitorBrandsRanked",
    retailOnly: true,
    label: "Competitor Brands (Ranked)",
    type: "multiselect",
    required: false,
    prompt:
      "Which *competitor brands* are present here? Reply with numbers *in order of sales volume* (most sold first), comma separated — up to 7, or SKIP if none:\n" +
      COMPETITOR_BRAND_OPTIONS.map((b, i) => `${i + 1}. ${b}`).join("\n"),
    options: COMPETITOR_BRAND_OPTIONS,
  },
  {
    key: "competitorOtherBrandNames",
    retailOnly: true,
    label: "Other Competitor Brand Names",
    type: "comments",
    required: true,
    prompt: "You selected 'Other' — name the additional brand(s), comma separated.",
    skipIf: (a) => !a.competitorBrandsRanked || !a.competitorBrandsRanked.includes("Other"),
    // engine.js's competitor loop triggers automatically off this step
    // finishing (or off competitorBrandsRanked directly if "Other" wasn't picked).
  },
];

const SURVEY_STEPS = [
  // ---- Section 1: Who and where ----
  {
    key: "accountName",
    label: "Store/Account Name",
    type: "text",
    required: true,
    prompt: "🏬 Let's get started — what's the *name of this store/account*?",
    opts: { min: 2, max: 60 },
    skipIf: (a) => !!a.storeId,
  },
  {
    key: "storeType",
    label: "Store Type",
    type: "select",
    required: true,
    prompt: "Got it. What *type of store* is this?\n" + STORE_TYPE_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: STORE_TYPE_OPTIONS,
    skipIf: (a) => !!a.storeId,
  },
  {
    key: "contactName",
    label: "Contact Person",
    type: "text",
    required: true,
    prompt: "Who did you speak with today? Their *name* (buyer, store manager, or merchandising contact).",
    opts: { min: 2, max: 50 },
    skipIf: (a) => !!a.storeId,
  },
  {
    key: "contactNumber",
    label: "Contact Number",
    type: "phone",
    required: false,
    prompt: "Got a *contact number* for them, in case we need to follow up? (e.g. +254712345678, or SKIP)",
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
    prompt: "📍 Drop a *location pin* so we've got this store on the map — or type the address if you can't share one.",
    skipIf: (a) => !!a.storeId,
  },

  // ---- HQ/Warehouse visit — only runs when storeType is Warehouse/HQ,
  // an entirely different kind of stop: no shelf, no selling. This is
  // where an agent sorts stocking issues, payments, and escalations
  // reported by branches. Every step here is tagged hqOnly (the inverse
  // of retailOnly below) so a retail visit never sees these questions.
  // Five topics only, kept deliberately short:
  //   1. Ravine's own stock + wholesale pricing (retail price not needed here)
  //   2. Competitor wholesale (per carton) + retail pricing
  //   3. Statement/invoice/payment issues
  //   4. Delivery issues
  //   5. AOB
  {
    key: "hqRavineStockWsPricing",
    label: "Ravine Stock & W/S Pricing",
    type: "comments",
    required: false,
    hqOnly: true,
    prompt:
      "Let's confirm *Ravine's stock and wholesale pricing* here (no need for retail prices — this is a warehouse check, not a shelf).\n" +
      "List SKU - stock level - W/S price/carton, one per line (e.g. \"Fino 500ml - 200 cartons - 660\"). Or SKIP.",
    opts: { max: 2000 },
  },
  {
    key: "hqCompetitorPricing",
    label: "Competitor W/S & Retail Pricing",
    type: "comments",
    required: false,
    hqOnly: true,
    prompt:
      "Any *competitor pricing* worth noting from here — wholesale (per carton) and retail?\n" +
      "List Brand - Variant - W/S price/carton - Retail price, one per line (e.g. \"Brookside - 500ml - 720 - 65\"). Or SKIP.",
    opts: { max: 2000 },
  },
  {
    key: "hqPaymentIssues",
    label: "Statement/Invoice/Payment Issues",
    type: "comments",
    required: true,
    hqOnly: true,
    prompt: "Any *statement, invoice, or payment issues* to flag?",
  },
  {
    key: "hqDeliveryIssues",
    label: "Delivery Issues",
    type: "comments",
    required: true,
    hqOnly: true,
    prompt: "Any *delivery issues* to flag?",
  },
  {
    key: "hqAob",
    label: "AOB",
    type: "comments",
    required: false,
    hqOnly: true,
    prompt: "Anything else? (*AOB* — any other business, or SKIP)",
  },

  // ---- Section 2: The shelf — walk over and take a look ----
  {
    key: "ravineStocked",
    retailOnly: true,
    label: "Is Ravine Stocked",
    type: "select",
    required: true,
    prompt: `Now let's check the shelf. Is *${PRODUCT_X_NAME}* stocked here today?\n1. Yes\n2. No`,
    options: ["Yes", "No"],
  },
  {
    key: "ravineCategoriesStocked",
    retailOnly: true,
    label: "Ravine Categories Stocked",
    type: "multiselect",
    required: true,
    prompt:
      "Good — which *product categories* are on the shelf? Reply with numbers, comma/space separated:\n" +
      RAVINE_CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    options: RAVINE_CATEGORIES,
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  {
    key: "skusStocked",
    retailOnly: true,
    label: "SKUs Stocked",
    type: "multiselect_dynamic",
    required: true,
    promptBuilder: (a) => {
      const cats = a.ravineCategoriesStocked || [];
      const options = cats.flatMap((c) => (RAVINE_CATALOG[c] || []).map((e) => e.sku));
      return {
        options,
        prompt:
          "And *specifically which SKUs*? Reply with numbers, comma/space separated:\n" +
          options.map((s, i) => `${i + 1}. ${s}`).join("\n"),
      };
    },
    skipIf: (a) => !a.ravineCategoriesStocked || a.ravineCategoriesStocked.length === 0,
    // engine.js's Ravine pricing loop triggers automatically off this exact key.
  },
  {
    key: "shelfPhoto",
    retailOnly: true,
    label: "Shelf/Chiller Photo",
    type: "photo",
    required: true,
    prompt: "📷 Before we get into the details, snap a *photo of the dairy shelf/chiller* so we've got a record of what you're seeing (attach via the 📎 icon > Camera/Gallery).",
  },
  {
    key: "shortExpiryPresent",
    retailOnly: true,
    label: "Short-Expiry Stock Present",
    type: "select",
    required: true,
    prompt: "While you're there — any *short-expiry stock* that needs attention?\n1. Yes\n2. No",
    options: ["Yes", "No"],
  },
  {
    key: "shortExpiryAction",
    retailOnly: true,
    label: "Short-Expiry Action Taken",
    type: "comments",
    required: false,
    prompt: "What *action* was taken or is needed for it (transfer, clearance deal, FIFO push)? Or SKIP.",
    skipIf: (a) => a.shortExpiryPresent !== "Yes",
  },
  {
    key: "shelfPosition",
    retailOnly: true,
    label: "Shelf Position",
    type: "select",
    required: true,
    prompt: "What *shelf position* is Ravine in?\n" + SHELF_POSITION_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SHELF_POSITION_OPTIONS,
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  // NOTE: facings + stock status used to be asked once overall here. Real
  // field data showed agents trying to report these per-SKU anyway (e.g.
  // "ESL 500ml 5 facings, ESL 200ml 2 facings..." typed into a single free
  // text box). Now captured per-SKU inside the Ravine pricing loop in
  // engine.js instead (see ravinePriceLoop's "facings"/"stockStatus" stages).
  {
    key: "priceVsCompetitor",
    retailOnly: true,
    label: "Price vs Nearest Competitor",
    type: "select",
    required: true,
    prompt: "How does Ravine's price compare to the *nearest competitor*?\n" + PRICE_VS_COMPETITOR_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: PRICE_VS_COMPETITOR_OPTIONS,
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  {
    key: "priceDifferenceAmount",
    retailOnly: true,
    label: "Price Difference Amount",
    type: "numeric",
    required: false,
    prompt: "By how much (KES)? (numbers only, or SKIP)",
    opts: { allowZero: true },
    skipIf: (a) => a.ravineStocked !== "Yes" || a.priceVsCompetitor === "Same",
  },
  {
    key: "shelfVisibilityRating",
    retailOnly: true,
    label: "Shelf Visibility Rating",
    type: "select",
    required: true,
    prompt: "How's the *shelf visibility*? Rate it 1 (poor) to 5 (excellent):\n" + SHELF_VISIBILITY_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SHELF_VISIBILITY_OPTIONS,
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  {
    key: "brandsNextToRavine",
    retailOnly: true,
    label: "Brands Shelved Next to Ravine",
    type: "text",
    required: false,
    prompt: "What *brands are shelved right next to* Ravine? (or SKIP)",
    opts: { min: 1, max: 100, titleCase: false },
    skipIf: (a) => a.ravineStocked !== "Yes",
  },
  ...competitorSteps,
  {
    key: "otherDairyCategoriesNote",
    retailOnly: true,
    label: "Other Dairy Categories Present",
    type: "comments",
    required: false,
    prompt: "Anything else on the shelf worth noting — other dairy categories not listed above? Or SKIP.",
    opts: { max: 2000 }, // often holds a multi-brand list (e.g. milk powder pricing), not a brief note
  },
  {
    key: "posMaterialsPresent",
    retailOnly: true,
    label: "POS Materials Present",
    type: "multiselect",
    required: true,
    prompt:
      "What *POS materials* are up? Reply with numbers, comma/space separated:\n" +
      POS_MATERIALS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: POS_MATERIALS_OPTIONS,
  },
  {
    key: "planogramCompliance",
    retailOnly: true,
    label: "Planogram Compliance",
    type: "select",
    required: true,
    prompt: "Is the *planogram* being followed?\n" + PLANOGRAM_COMPLIANCE_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: PLANOGRAM_COMPLIANCE_OPTIONS,
  },
  {
    key: "secondaryDisplay",
    retailOnly: true,
    label: "Secondary Display",
    type: "select",
    required: true,
    prompt: "Any *secondary display* in place?\n" + SECONDARY_DISPLAY_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SECONDARY_DISPLAY_OPTIONS,
  },

  // ---- Section 3: A word with the team ----
  {
    key: "staffCanRecommend",
    retailOnly: true,
    label: "Can Store Staff Recommend Ravine",
    type: "select",
    required: true,
    prompt: "One for the team — can *store staff recommend* Ravine to customers?\n" + STAFF_RECOMMEND_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: STAFF_RECOMMEND_OPTIONS,
  },
  {
    key: "issuesObserved",
    retailOnly: true,
    label: "Issues Observed",
    type: "comments",
    required: true,
    prompt: "Any *issues* you spotted? Expired stock, poor rotation, damaged packs, missing price tags — whatever you noticed.",
  },
  {
    key: "merchandisingOpportunities",
    retailOnly: true,
    label: "Merchandising Opportunities",
    type: "comments",
    required: true,
    prompt: "Any *merchandising opportunities* worth chasing here?",
  },

  // ---- Section 4: Business & payments ----
  {
    key: "digitalPathStatus",
    retailOnly: true,
    label: "Digital Path Ordering Status",
    type: "select",
    required: true,
    prompt:
      "Now for the business side — what's the status of this account's *Digital Path ordering account*?\n" +
      DIGITAL_PATH_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: DIGITAL_PATH_STATUS_OPTIONS,
  },
  {
    key: "digitalPathIssueNote",
    retailOnly: true,
    label: "Digital Path Issue Detail",
    type: "comments",
    required: false,
    prompt: "Briefly, what's the *issue* (e.g. account disabled due to overdue payment, naming mismatch, system glitch)? Or SKIP.",
    skipIf: (a) => a.digitalPathStatus === "Active / Working",
  },
  {
    key: "pendingOrders",
    retailOnly: true,
    label: "Pending Orders Awaiting Fulfilment",
    type: "select",
    required: true,
    prompt: "Any *pending orders* awaiting fulfilment (due to stock or system issues)?\n1. Yes\n2. No",
    options: ["Yes", "No"],
  },
  {
    key: "paymentStatus",
    retailOnly: true,
    label: "Account Payment Status",
    type: "select",
    required: true,
    prompt: "What's this account's *payment status*?\n" + PAYMENT_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: PAYMENT_STATUS_OPTIONS,
    crossValidate: (value) => {
      if (value !== "Current / Up to Date") {
        return { flagged: true, note: "Overdue account — flagged for collections follow-up." };
      }
      return { flagged: false };
    },
  },
  {
    key: "outstandingBalance",
    retailOnly: true,
    label: "Outstanding Balance (KES)",
    type: "numeric",
    required: false,
    prompt: "What's the total *outstanding balance* owed, if any (KES)? (numbers only, or SKIP)",
    opts: { allowZero: true },
  },
  {
    key: "collectionAmount",
    retailOnly: true,
    label: "Collection Amount Today (KES)",
    type: "numeric",
    required: false,
    prompt: "Did you *collect* anything today? (numbers only, or SKIP)",
    opts: { allowZero: true },
  },
  {
    key: "writtenCommitmentObtained",
    retailOnly: true,
    label: "Written Payment Commitment Obtained",
    type: "select",
    required: false,
    prompt: "Did you get a *written payment commitment* from them?\n1. Yes\n2. No",
    options: ["Yes", "No"],
    skipIf: (a) => a.paymentStatus === "Current / Up to Date",
  },

  // ---- Section 5: Wrap-up ----
  {
    key: "additionalRecommendations",
    label: "Additional Recommendations",
    type: "comments",
    required: true,
    retailOnly: true, // HQ visits get hqAob instead -- avoids asking "anything else" twice
    prompt: "Last thing — anything else worth flagging before we wrap up?",
  },
];

const COLUMNS = [
  "referenceNumber",
  "submittedAt",
  "submittedAtDate",
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
  "hqRavineStockWsPricing",
  "hqCompetitorPricing",
  "hqPaymentIssues",
  "hqDeliveryIssues",
  "hqAob",
  "digitalPathStatus",
  "digitalPathIssueNote",
  "pendingOrders",
  "ravineStocked",
  "ravineCategoriesStocked",
  ...RAVINE_CATEGORIES.map((c) => `Category 1/0: ${c}`),
  "skusStocked",
  // One contiguous block per SKU — everything about Fino 500ml sits
  // together, then everything about ESL 500ml, etc. — rather than
  // scattering the same SKU's columns across three separate locations.
  ...RAVINE_SKU_LIST.flatMap((e) => [
    `SKU 1/0: ${e.sku}`,
    `${e.sku} (WS/Carton)`,
    `${e.sku} (Retail/Piece)`,
    `${e.sku} Facings`,
    `${e.sku} Stock Status`,
    `${e.sku} Stock Status Note`,
  ]),
  "shelfPosition",
  "priceVsCompetitor",
  "priceDifferenceAmount",
  "shelfVisibilityRating",
  "brandsNextToRavine",
  "competitorBrandsRanked",
  // Same grouping principle: one contiguous block per competitor brand.
  ...COMPETITOR_BRANDS.flatMap((b) => [
    `Competitor 1/0: ${b}`,
    `${b} Categories`, `${b} Regular Price`, `${b} Promo Price`,
    ...RAVINE_CATEGORIES.map((c) => `${b} ${c} Detail`),
  ]),
  "Other Competitor Brands & Pricing", // catch-all for any brand not in the fixed 7
  "otherDairyCategoriesNote",
  "posMaterialsPresent",
  ...POS_MATERIALS_OPTIONS.map((p) => `POS 1/0: ${p}`),
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
  "outstandingBalance",
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
  RAVINE_CATEGORIES,
  RAVINE_CATALOG,
  RAVINE_SKU_LIST,
  RAVINE_SKU_INDEX,
  RAVINE_SKU_TO_CATEGORY,
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
  COMPETITOR_BRANDS,
  COMPETITOR_BRAND_OPTIONS,
};
