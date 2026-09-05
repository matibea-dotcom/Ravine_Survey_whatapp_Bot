// Central registry of survey tracks. Add a new track by creating
// src/surveys/<key>.js (same shape as gt.js/mt.js) and adding it to TRACKS
// below — nothing else in the engine needs to change.

const gt = require("./gt");
const mt = require("./mt");
const insurance = require("./insurance");

const TRACKS = {
  GT: gt,
  MT: mt,
  INSURANCE: insurance,
};

const TRACK_ORDER = ["GT", "MT", "INSURANCE"];

function trackLabel(key) {
  return TRACKS[key]?.label || key;
}

function trackOptionsPrompt() {
  return TRACK_ORDER.map((key, i) => `${i + 1}. ${trackLabel(key)}`).join("\n");
}

function trackKeyFromIndex(idx) {
  return TRACK_ORDER[idx - 1] || null;
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

// ---- Registration steps: shared identity fields + a track-selection step ----
// This runs once per new WhatsApp number, same as before, with one extra
// question appended at the end.
const REGISTRATION_STEPS = [
  { key: "fullName", label: "Full Name", type: "text", prompt: "Welcome! Let's get you set up. What is your *full name*?" },
  { key: "agentId", label: "Employee/Agent ID", type: "text", prompt: "Thanks. What is your *Employee/Agent ID*?", opts: { max: 20, titleCase: false } },
  { key: "region", label: "Region/Territory", type: "text", prompt: "Which *region or territory* do you cover?" },
  { key: "companyName", label: "Company Name", type: "text", prompt: "Which *company* are you registering with?" },
  {
    key: "surveyTrack",
    label: "Survey Track",
    type: "trackSelect", // handled specially in engine.js registration flow
    prompt: `Last step — which survey will you be completing?\n${trackOptionsPrompt()}`,
  },
];

function trackKeyFromArg(arg) {
  const trimmed = String(arg).trim();
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric)) return trackKeyFromIndex(numeric);
  const upperArg = trimmed.toUpperCase();
  return TRACK_ORDER.includes(upperArg) ? upperArg : null;
}

module.exports = {
  TRACKS,
  TRACK_ORDER,
  trackLabel,
  trackOptionsPrompt,
  trackKeyFromIndex,
  trackKeyFromArg,
  getSurveyStepsForTrack,
  getColumnsForTrack,
  getSheetTabForTrack,
  REGISTRATION_STEPS,
};
