// Central registry of survey tracks. Add a new track by creating
// src/surveys/<key>.js (same shape as gt.js/mt.js) and adding it to TRACKS
// below — nothing else in engine.js needs to change.
//
// ACTIVE / SUSPENDED SURVEYS
// Which tracks anyone can actually reach is controlled by ONE environment
// variable, ACTIVE_SURVEYS (comma-separated track keys), e.g.
//     ACTIVE_SURVEYS=INSURANCE            -> only the insurance survey is live
//     ACTIVE_SURVEYS=INSURANCE,MT,GT      -> all three live
// Suspended tracks are never deleted: their code, sheet tabs and dashboards
// stay exactly as they are. They simply stop being offered, started, resumed
// or switched to until they are added back to ACTIVE_SURVEYS. If the variable
// is missing or has no valid keys, only DEFAULT_ACTIVE is live.

const gt = require("./gt");
const mt = require("./mt");
const insurance = require("./insurance");

const TRACKS = { GT: gt, MT: mt, INSURANCE: insurance };
// Warehouse/HQ visits are a store-type branch inside MT (see storeType ===
// "Warehouse/HQ" in mt.js), not a track someone registers into and
// switches out of. The old standalone WAREHOUSE track was confirmed
// unused and fully removed rather than kept as a backward-compat shim.
const TRACK_ORDER = ["GT", "MT", "INSURANCE"];
const DEFAULT_ACTIVE = ["INSURANCE"];

function activeTrackKeys() {
  const raw = process.env.ACTIVE_SURVEYS;
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_ACTIVE];
  const wanted = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const valid = TRACK_ORDER.filter((k) => wanted.includes(k)); // keeps menu order stable
  if (valid.length === 0) {
    console.warn(`ACTIVE_SURVEYS="${raw}" has no valid track keys (${TRACK_ORDER.join(", ")}). Falling back to ${DEFAULT_ACTIVE.join(",")}.`);
    return [...DEFAULT_ACTIVE];
  }
  return valid;
}

function isTrackActive(key) {
  return activeTrackKeys().includes(key);
}

// When every live survey is completed by the public (the insurance proposer
// fills it in themselves), nobody needs to register as an agent first.
function isPublicOnlyMode() {
  const keys = activeTrackKeys();
  return keys.length > 0 && keys.every((k) => TRACKS[k]?.publicAccess === true);
}

function getTrackModule(track) {
  return TRACKS[track] || null;
}

function trackLabel(key) {
  return TRACKS[key]?.label || key;
}

function trackOptionsPrompt() {
  return activeTrackKeys().map((key, i) => `${i + 1}. ${trackLabel(key)}`).join("\n");
}

function trackKeyFromIndex(idx) {
  return activeTrackKeys()[idx - 1] || null;
}

function trackKeyFromArg(arg) {
  const trimmed = String(arg).trim();
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric)) return trackKeyFromIndex(numeric);
  const upperArg = trimmed.toUpperCase();
  return activeTrackKeys().includes(upperArg) ? upperArg : null;
}

// True for a real track key that exists but is currently suspended.
function isSuspendedTrackArg(arg) {
  const upperArg = String(arg).trim().toUpperCase();
  return TRACK_ORDER.includes(upperArg) && !isTrackActive(upperArg);
}

// The track an agent actually gets when they START/RESTART/RESUME: their
// registered track if it is live, otherwise the first live track.
function resolveTrackForAgent(agent) {
  const mine = agent && agent.surveyTrack;
  if (mine && isTrackActive(mine)) return mine;
  return activeTrackKeys()[0];
}

function getSurveyStepsForTrack(track) {
  return (TRACKS[track] || TRACKS.GT).SURVEY_STEPS;
}

function getColumnsForTrack(track) {
  return (TRACKS[track] || TRACKS.GT).COLUMNS;
}

function getSheetTabForTrack(track) {
  const cfg = TRACKS[track] || TRACKS.GT;
  return process.env[cfg.sheetTabEnvVar] || cfg.defaultSheetTab;
}

// ---- Registration: shared identity fields + a track-selection step ----
// Runs once per new WhatsApp number (agents only — public-access tracks
// skip it, see isPublicOnlyMode). Field keys (fullName, agentId, region,
// companyName) match what's already in your Agents sheet tab exactly.
const REGISTRATION_STEPS = [
  { key: "fullName", label: "Full Name", type: "text", prompt: "Welcome! Let's get you set up. What is your *full name*?" },
  { key: "agentId", label: "Employee/Agent ID", type: "text", prompt: "Thanks. What is your *Employee/Agent ID*?", opts: { max: 20, titleCase: false } },
  { key: "region", label: "Region/Territory", type: "text", prompt: "Which *region or territory* do you cover?" },
  { key: "companyName", label: "Company Name", type: "text", prompt: "Which *company* are you registering with?" },
  {
    key: "surveyTrack",
    label: "Survey Track",
    type: "trackSelect", // handled specially in engine.js's registration flow
    // A getter so the menu always reflects the CURRENT ACTIVE_SURVEYS value.
    get prompt() {
      return `Last step — which survey will you be completing?\n${trackOptionsPrompt()}`;
    },
  },
];

module.exports = {
  TRACKS,
  TRACK_ORDER,
  DEFAULT_ACTIVE,
  activeTrackKeys,
  isTrackActive,
  isPublicOnlyMode,
  getTrackModule,
  trackLabel,
  trackOptionsPrompt,
  trackKeyFromIndex,
  trackKeyFromArg,
  isSuspendedTrackArg,
  resolveTrackForAgent,
  getSurveyStepsForTrack,
  getColumnsForTrack,
  getSheetTabForTrack,
  REGISTRATION_STEPS,
};
