// Warehouse/HQ survey — a meeting-notes style record for visits to the
// warehouse/head office, covering the three standing discussion topics:
// payments & outstanding dues, stock levels across branches, and short
// expiries. Unlike GT/MT, this isn't a per-store shelf audit, so it skips
// GPS/photo capture and is scoped to what actually gets discussed.

const SHORT_EXPIRY_ACTIONS = ["Discount/Promo Push", "Return to Supplier", "Write-off", "Transfer to Another Branch", "Other"];
const URGENCY_OPTIONS = ["Low", "Medium", "High", "Critical"];

const SURVEY_STEPS = [
  {
    key: "meetingAttendees",
    label: "Meeting Attendees",
    type: "text",
    required: true,
    prompt: "Who *attended* this warehouse/HQ discussion? (names/roles, comma separated)",
    opts: { min: 2, max: 300 },
  },

  // ---- Section 1: Payments & Outstanding Dues ----
  {
    key: "totalOutstandingDiscussed",
    label: "Total Outstanding Discussed (KES)",
    type: "numeric",
    required: false,
    prompt: "What is the *total outstanding balance* discussed today across accounts (KES)? (numbers only, or SKIP)",
    opts: { allowZero: true },
  },
  {
    key: "topOverdueAccounts",
    label: "Top Overdue Accounts Flagged",
    type: "comments",
    required: false,
    prompt: "Which *accounts or sales reps* were flagged as most overdue? (names, one per line, or SKIP)",
  },
  {
    key: "collectionActionPlan",
    label: "Collection Action Plan",
    type: "comments",
    required: true,
    prompt: "What *collection action plan* was agreed on? (who's following up, and how)",
  },
  {
    key: "collectionTargetDate",
    label: "Collection Target Date",
    type: "text",
    required: false,
    prompt: "What *target date* was set for the next collections review? (e.g. 30 Sep 2026, or SKIP)",
    opts: { min: 2, max: 60 },
  },

  // ---- Section 2: Stock Levels at Branches ----
  {
    key: "branchesDiscussed",
    label: "Branches Discussed",
    type: "text",
    required: true,
    prompt: "Which *branches/warehouses* were discussed? (names, comma separated)",
    opts: { min: 2, max: 300 },
  },
  {
    key: "stockLevelSummary",
    label: "Stock Level Summary",
    type: "comments",
    required: true,
    prompt: "Summarize the *stock level situation* across those branches — what's healthy, what's tight.",
  },
  {
    key: "stockShortagesIdentified",
    label: "Stock Shortages Identified",
    type: "comments",
    required: false,
    prompt: "Any *specific shortages* identified (SKU + branch)? One per line, or SKIP if none.",
  },
  {
    key: "restockActionPlan",
    label: "Restock Action Plan",
    type: "comments",
    required: false,
    prompt: "What *restock action plan* was agreed on for any shortages? Or SKIP if not applicable.",
    skipIf: (a) => !a.stockShortagesIdentified,
  },

  // ---- Section 3: Short Expiries ----
  {
    key: "shortExpiryPresent",
    label: "Short-Expiry Stock Discussed",
    type: "select",
    required: true,
    prompt: "Was *short-expiry stock* discussed today?\n1. Yes\n2. No",
    options: ["Yes", "No"],
  },
  {
    key: "shortExpirySkusAffected",
    label: "Short-Expiry SKUs Affected",
    type: "comments",
    required: true,
    prompt: "Which *SKUs and quantities* are affected by short expiry? (one per line, e.g. \"Fino 500ml - 40 cartons\")",
    skipIf: (a) => a.shortExpiryPresent !== "Yes",
  },
  {
    key: "shortExpiryUrgency",
    label: "Short-Expiry Urgency",
    type: "select",
    required: true,
    prompt: "How *urgent* is this short-expiry situation?\n" + URGENCY_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: URGENCY_OPTIONS,
    skipIf: (a) => a.shortExpiryPresent !== "Yes",
  },
  {
    key: "shortExpiryAction",
    label: "Short-Expiry Action Plan",
    type: "select",
    required: true,
    prompt: "What *action* was agreed for this stock?\n" + SHORT_EXPIRY_ACTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    options: SHORT_EXPIRY_ACTIONS,
    skipIf: (a) => a.shortExpiryPresent !== "Yes",
  },
  {
    key: "shortExpiryDeadline",
    label: "Short-Expiry Deadline",
    type: "text",
    required: false,
    prompt: "What *deadline* was set to action this? (e.g. 25 Sep 2026, or SKIP)",
    opts: { min: 2, max: 60 },
    skipIf: (a) => a.shortExpiryPresent !== "Yes",
  },

  // ---- Closing ----
  {
    key: "additionalNotes",
    label: "Additional Notes",
    type: "comments",
    required: false,
    prompt: "Any other *notes* from this discussion? Or SKIP.",
  },
  {
    key: "nextMeetingDate",
    label: "Next Meeting Date",
    type: "text",
    required: false,
    prompt: "When is the *next warehouse/HQ review* scheduled? (or SKIP if not yet set)",
    opts: { min: 2, max: 60 },
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
  "meetingAttendees",
  "totalOutstandingDiscussed",
  "topOverdueAccounts",
  "collectionActionPlan",
  "collectionTargetDate",
  "branchesDiscussed",
  "stockLevelSummary",
  "stockShortagesIdentified",
  "restockActionPlan",
  "shortExpiryPresent",
  "shortExpirySkusAffected",
  "shortExpiryUrgency",
  "shortExpiryAction",
  "shortExpiryDeadline",
  "additionalNotes",
  "nextMeetingDate",
  "flags",
];

module.exports = {
  label: "Warehouse/HQ",
  sheetTabEnvVar: "GOOGLE_SHEET_TAB_WAREHOUSE",
  defaultSheetTab: "Warehouse_Submissions",
  SURVEY_STEPS,
  COLUMNS,
};
