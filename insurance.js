// Insurance survey — placeholder. Track is registerable now so agents can be
// pointed here later without re-registering; question set to follow.

const SURVEY_STEPS = [
  {
    key: "comingSoonAck",
    label: "Coming Soon Acknowledgement",
    type: "text",
    required: true,
    prompt:
      "The Insurance survey isn't live yet. Type ANYTHING to acknowledge — your registration is saved and you'll be notified once it's ready.",
    opts: { min: 1, max: 200 },
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
  "comingSoonAck",
  "flags",
];

module.exports = {
  label: "Insurance (Coming Soon)",
  sheetTabEnvVar: "GOOGLE_SHEET_TAB_INSURANCE",
  defaultSheetTab: "Insurance_Submissions",
  SURVEY_STEPS,
  COLUMNS,
};
