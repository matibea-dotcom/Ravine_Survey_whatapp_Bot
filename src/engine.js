const sessionStore = require("./sessionStore");
const agentStore = require("./agentStore");
const validators = require("./validators");
const sheets = require("./sheets");
const {
  REGISTRATION_STEPS,
  TRACK_ORDER,
  trackLabel,
  trackOptionsPrompt,
  trackKeyFromIndex,
  trackKeyFromArg,
  getSurveyStepsForTrack,
} = require("./surveys");

const MAX_RETRIES = 3;
const MAX_BACK = 5;
const GLOBAL_COMMANDS = [
  "HELP", "BACK", "MENU", "SAVE", "RESUME", "CANCEL", "STATUS",
  "RESTART", "EXIT", "SUMMARY",
];
const SURVEY_COMMANDS = ["START", "SKIP", "EDIT", "SUBMIT", "CONFIRM"];
const ADMIN_COMMANDS = ["REPORT", "MYDATA", "STATS"];

const recentSubmissions = new Map();
const registrationStates = new Map();
const offTopicStreaks = new Map();

// --- Helper: Get raw text from message ---
function getRawText(message) {
  return message.type === "text" ? message.text.body : "";
}

// --- Off-topic detection (reserved for future use — not currently called
// internally, but kept intentionally per prior commit for an upcoming
// smarter off-topic classifier to replace the simple streak-counter in
// handleOffTopicOrIdle below). Not exported, so nothing outside this file
// can call it either way. ---
function isOffTopic(text) {
  const t = text.trim().toUpperCase();
  if (GLOBAL_COMMANDS.includes(t) || SURVEY_COMMANDS.includes(t) || ADMIN_COMMANDS.includes(t)) {
    return false;
  }
  return false;
}

// --- Admin gate: checks authorization and pushes the standard refusal
// message if not, so every admin-only command can do `if (!requireAdmin(...))
// return replies;` instead of repeating the same 3-line check. ---
function requireAdmin(waId, replies) {
  if (!agentStore.isAuthorizedAdmin(waId)) {
    replies.push("That command is only available to authorized users.");
    return false;
  }
  return true;
}

// --- Duplicate detection (SOW 2.4) ---
// GT dedupes on retailerName, MT on accountName — fall back to whichever is
// present so this works across tracks without each track's own code change.
function submissionDupeKey(answers) {
  return answers.retailerName || answers.accountName || "";
}

function recordSubmissionForDupeCheck(waId, dupeKey) {
  const list = recentSubmissions.get(waId) || [];
  list.push({ dupeKey: dupeKey.toLowerCase(), at: Date.now() });
  recentSubmissions.set(waId, list.filter((e) => Date.now() - e.at < 24 * 3600 * 1000));
}

function findRecentDuplicate(waId, dupeKey) {
  if (!dupeKey) return null;
  const list = recentSubmissions.get(waId) || [];
  return list.find(
    (e) => e.dupeKey === dupeKey.toLowerCase() && Date.now() - e.at < 4 * 3600 * 1000
  );
}

// --- Survey step navigation (track-aware) ---
// Converts a Stores-tab record back into survey answer shape so selecting an
// existing store pre-fills identity fields exactly as if freshly typed.
function storeToAnswers(store) {
  const lat = store.gpsLat !== "" ? parseFloat(store.gpsLat) : null;
  const lng = store.gpsLng !== "" ? parseFloat(store.gpsLng) : null;
  return {
    accountName: store.storeName,
    storeType: store.storeType,
    contactName: store.contactName,
    contactNumber: store.contactNumber || undefined,
    areaLocation: store.areaLocation,
    gpsLocation: {
      lat: Number.isNaN(lat) ? null : lat,
      lng: Number.isNaN(lng) ? null : lng,
      address: store.gpsAddress || null,
      source: store.gpsSource || "stored",
      capturedAt: new Date().toISOString(),
    },
    storeId: store.storeId,
  };
}

function surveyStepsFor(session) {
  return getSurveyStepsForTrack(session.track);
}

function activeSteps(session) {
  return surveyStepsFor(session).filter((s) => !(s.skipIf && s.skipIf(session.answers)));
}

function currentStep(session) {
  const steps = activeSteps(session);
  return steps[session.stepIndex] || null;
}

function stepPrompt(step, answers) {
  return step.promptBuilder ? step.promptBuilder(answers).prompt : step.prompt;
}

function stepOptions(step, answers) {
  return step.promptBuilder ? step.promptBuilder(answers).options : step.options;
}

function progressLine(session) {
  const steps = activeSteps(session);
  return `Step ${session.stepIndex + 1} of ${steps.length}`;
}

function advance(session) {
  session.stepIndex += 1;
}

// --- UI Text ---
function helpText(registered) {
  if (!registered) {
    return "Reply to the prompts to complete registration. Type EXIT to stop at any time.";
  }
  return (
    "*Commands*\n" +
    "START - begin a new survey\n" +
    "SKIP - skip an optional question\n" +
    "BACK - previous question\n" +
    "EDIT - edit a previous answer\n" +
    "SUMMARY - show current answers\n" +
    "SAVE - save & pause\n" +
    "RESUME - continue a saved survey\n" +
    "STATUS - show progress\n" +
    "CANCEL - cancel this survey\n" +
    "RESTART - start this survey over\n" +
    "SUBMIT - submit completed survey\n" +
    "RESETAGENT - remove your registration entirely (re-register from scratch)\n" +
    "MYTRACK - show your current survey track\n" +
    "SWITCHTRACK <track> - change your survey track (e.g. SWITCHTRACK MT)\n" +
    "MENU - show this menu\n" +
    "EXIT - end session"
  );
}

function summaryText(session) {
  const steps = activeSteps(session);
  const lines = steps
    .filter((s) => session.answers[s.key] !== undefined)
    .map((s) => {
      const v = session.answers[s.key];
      const display = Array.isArray(v)
        ? v.join(", ")
        : typeof v === "object" && v !== null
        ? v.address || (v.mediaId ? `Photo received${v.caption ? ` ("${v.caption}")` : ""}` : `${v.lat}, ${v.lng}`)
        : String(v);
      return `• ${s.label}: ${display}`;
    });

  const skuPricing = session.answers.productXSkuPricing;
  if (skuPricing && Object.keys(skuPricing).length > 0) {
    lines.push(
      ...Object.entries(skuPricing).map(([sku, p]) => `• ${sku}: WS ${p.ws ?? "-"} / RRP ${p.rrp ?? "-"}`)
    );
  }

  return lines.length ? lines.join("\n") : "No answers captured yet.";
}

function promptForCurrentOrSummary(session) {
  const step = currentStep(session);
  if (!step) {
    return [
      "🎉 That's everything! Here's your summary:\n\n" +
        summaryText(session) +
        "\n\nType SUBMIT to finish, or EDIT to change an answer.",
    ];
  }
  return [`${stepPrompt(step, session.answers)}\n\n${progressLine(session)}`];
}

// --- SKU Loop (works the same regardless of track, driven by whichever
// step's key triggers it — see the bottom of handleInboundMessage) ---
function promptForSkuLoopOrContinue(session) {
  const loop = session.skuLoop;
  if (loop.index >= loop.skus.length) {
    session.skuLoop = null;
    advance(session);
    return promptForCurrentOrSummary(session);
  }
  const sku = loop.skus[loop.index];
  const label = loop.field === "ws" ? "wholesale price" : "RRP (recommended retail price)";
  return [`What is the *${label}* for *${sku}*? (numbers only, or SKIP)`];
}

function advanceSkuLoop(loop) {
  if (loop.field === "ws") {
    loop.field = "rrp";
  } else {
    loop.field = "ws";
    loop.index += 1;
  }
}

function handleSkuLoop(session, message, upper, replies) {
  const loop = session.skuLoop;
  const sku = loop.skus[loop.index];

  if (["SUBMIT", "EDIT", "BACK"].includes(upper)) {
    replies.push(
      `Please finish entering SKU pricing first (type SKIP to skip this one), then ${upper} again.`
    );
    return replies;
  }

  if (upper === "SKIP") {
    advanceSkuLoop(loop);
    replies.push(...promptForSkuLoopOrContinue(session));
    return replies;
  }

  const result = validators.validateNumeric(getRawText(message), { allowZero: false });
  if (!result.ok) {
    replies.push(`${result.error} Or type SKIP to skip this price.`);
    return replies;
  }

  session.answers.productXSkuPricing = session.answers.productXSkuPricing || {};
  session.answers.productXSkuPricing[sku] = session.answers.productXSkuPricing[sku] || {};

  if (loop.field === "ws") {
    session.answers.productXSkuPricing[sku].ws = result.value;
  } else {
    const ws = session.answers.productXSkuPricing[sku].ws;
    if (ws != null && result.value < ws) {
      session.flags = session.flags || [];
      session.flags.push(`${sku}: RRP is lower than wholesale price — flagged for review.`);
      replies.push("Noted (RRP lower than wholesale — flagged for review).");
    }
    session.answers.productXSkuPricing[sku].rrp = result.value;
  }

  advanceSkuLoop(loop);
  replies.push(...promptForSkuLoopOrContinue(session));
  return replies;
}

// --- Answer validation ---
function processAnswer(step, message, answers) {
  if (step.type === "location") {
    return validators.validateLocation(message);
  }
  if (step.type === "photo") {
    return validators.validatePhoto(message);
  }
  const raw = getRawText(message);
  switch (step.type) {
    case "text":
      return validators.validateText(raw, step.opts);
    case "comments":
      return validators.validateComments(raw);
    case "phone":
      return validators.validatePhone(raw);
    case "numeric":
      return validators.validateNumeric(raw, step.opts);
    case "select":
      return validators.validateSelect(raw, stepOptions(step, answers));
    case "multiselect":
      return validators.validateMultiSelect(raw, stepOptions(step, answers), { allowNone: !!step.allowNone });
    case "multiselect_dynamic":
      return validators.validateMultiSelect(raw, stepOptions(step, answers), { allowNone: false });
    default:
      return { ok: false, error: "Unsupported input type." };
  }
}

// --- Global command handler ---
function handleGlobalCommand(waId, agent, session, cmd, replies) {
  switch (cmd) {
    case "HELP":
    case "MENU":
      replies.push(helpText(true));
      return;
    case "STATUS":
      replies.push(session ? `${progressLine(session)}\nStatus: ${session.status}` : "No active survey. Type START to begin.");
      return;
    case "SUMMARY":
      replies.push(session ? summaryText(session) : "No active survey yet.");
      return;
    case "SAVE":
      if (session) {
        sessionStore.pause(session);
        replies.push(`Progress saved (Ref: ${session.sessionId}). Type RESUME within ${sessionStore.RESUME_HOURS}h to continue.`);
      } else {
        replies.push("No active survey to save.");
      }
      return;
    case "RESUME":
      if (!session) {
        replies.push("No saved survey found. Type START to begin a new one.");
      } else if (sessionStore.isExpiredForResume(session)) {
        sessionStore.clear(waId);
        replies.push("Your saved survey expired. Type START to begin a new one.");
      } else {
        if (!session.track) session.track = agent.surveyTrack || "GT";
        sessionStore.touch(session);
        const step = currentStep(session);
        replies.push(`Resuming ${trackLabel(session.track)} survey (Ref: ${session.sessionId}).\n\n${stepPrompt(step, session.answers)}\n\n${progressLine(session)}`);
      }
      return;
    case "CANCEL":
      if (session) {
        session.status = "cancelled";
        replies.push("Survey cancelled. Type START to begin a new one.");
      } else {
        replies.push("No active survey to cancel.");
      }
      return;
    case "RESTART": {
      const fresh = sessionStore.newSession(waId);
      fresh.track = agent.surveyTrack || "GT";
      replies.push(`${trackLabel(fresh.track)} survey restarted (Ref: ${fresh.sessionId}).\n\n${stepPrompt(currentStep(fresh), fresh.answers)}\n\n${progressLine(fresh)}`);
      return;
    }
    case "EXIT":
      if (session) sessionStore.pause(session);
      replies.push("Session ended. Your progress (if any) is saved. Type RESUME or START any time.");
      return;
    default:
      replies.push(helpText(true));
  }
}

// --- Admin command handler ---
async function handleAdminCommand(cmd, replies) {
  switch (cmd) {
    case "REPORT":
      replies.push("A summary report request has been logged. Your supervisor will receive it shortly.");
      return replies;
    case "MYDATA":
      replies.push("Your submission history will be sent shortly.");
      return replies;
    case "STATS":
      replies.push("Your personal stats will be sent shortly.");
      return replies;
    default:
      replies.push("Unknown admin command.");
      return replies;
  }
}

// --- Self-service: fully remove your own registration (re-register from scratch) ---
async function handleResetAgent(waId, session, replies) {
  const success = await agentStore.clearAgent(waId);
  if (success) {
    sessionStore.clear(waId);
    clearRegistrationState(waId);
    replies.push("✅ Your agent registration has been removed. Type HELP or reply to register again with a new survey track.");
  } else {
    replies.push("⚠️ Failed to reset your registration. Please contact your supervisor for assistance.");
  }
  return replies;
}

// --- Submit handlers ---
async function handleSubmit(waId, agent, session, replies) {
  const steps = surveyStepsFor(session);
  const missing = steps.filter(
    (s) => s.required && !s.skipIf?.(session.answers) && session.answers[s.key] === undefined
  );
  if (missing.length > 0) {
    replies.push(
      "Some required fields are still missing:\n" +
        missing.map((s) => `• ${s.label}`).join("\n") +
        "\n\nPlease complete these before submitting."
    );
    return replies;
  }

  const dupeKey = submissionDupeKey(session.answers);
  const dupe = findRecentDuplicate(waId, dupeKey);
  if (dupe && !session.dupeConfirmed) {
    replies.push(
      `⚠️ You already submitted a survey for *${dupeKey}* recently. Is this a new visit?\n` +
        "Reply CONFIRM to submit anyway, or CANCEL to discard."
    );
    session.pendingSubmit = true;
    session.dupeConfirmed = "pending";
    return replies;
  }

  replies.push("*Final Summary*\n\n" + summaryText(session) + "\n\nReply CONFIRM to submit, or EDIT to make changes.");
  session.pendingSubmit = true;
  return replies;
}

async function finalizeSubmit(waId, agent, session, replies) {
  const referenceNumber = `REF-${Date.now().toString(36).toUpperCase()}`;
  session.flags = session.flags || [];

  const elapsedMin = (Date.now() - session.createdAt) / 60000;
  if (elapsedMin < 2) session.flags.push("Survey completed in under 2 minutes.");

  ["retailerName", "accountName", "contactName"].forEach((k) => {
    if (session.answers[k] && validators.isGenericTestValue(session.answers[k])) {
      session.flags.push(`Generic/test value detected for ${k}.`);
    }
  });

  const submission = {
    referenceNumber,
    submittedAt: new Date().toISOString(),
    sessionId: session.sessionId,
    track: session.track,
    agent,
    answers: session.answers,
    flags: session.flags,
  };

  try {
    await sheets.appendSubmission(submission);
    recordSubmissionForDupeCheck(waId, submissionDupeKey(session.answers));
    session.status = "submitted";
    session.pendingSubmit = false;
    replies.push(`✅ Survey submitted! Reference: *${referenceNumber}*\n\nThank you, ${agent.fullName}. Type START to begin another survey.`);
  } catch (err) {
    console.error("Sheets append failed:", err.message);
    replies.push(`⚠️ Something went wrong saving your survey. Your progress is safe — reference ${referenceNumber}. Type RESUME to try again shortly.`);
    session.pendingSubmit = false;
    sessionStore.pause(session);
  }
  return replies;
}

// --- Registration handler ---
async function handleRegistration(waId, message, replies) {
  let regState = registrationState(waId);
  const raw = getRawText(message);

  if (!regState.started) {
    replies.push(REGISTRATION_STEPS[0].prompt);
    regState.started = true;
    regState.index = 0;
    saveRegistrationState(waId, regState);
    return replies;
  }

  const step = REGISTRATION_STEPS[regState.index];

  // The track-selection step is a numbered select, not free text.
  if (step.type === "trackSelect") {
    const idx = Number(raw.trim());
    const trackKey = trackKeyFromIndex(idx);
    if (!trackKey) {
      replies.push(`Please reply with a number from 1 to ${TRACK_ORDER.length}.`);
      return replies;
    }
    regState.answers[step.key] = trackKey;
    regState.index += 1;
    saveRegistrationState(waId, regState);
  } else {
    const result = validators.validateText(raw, step.opts || { min: 1, max: 50 });
    if (!result.ok) {
      replies.push(result.error);
      return replies;
    }
    regState.answers[step.key] = result.value;
    regState.index += 1;
    saveRegistrationState(waId, regState);
  }

  if (regState.index >= REGISTRATION_STEPS.length) {
    await agentStore.registerAgent(waId, regState.answers);
    clearRegistrationState(waId);
    replies.push(
      `Thanks, ${regState.answers.fullName}! You're registered for the *${trackLabel(regState.answers.surveyTrack)}* survey. ` +
        "Type START to begin your first submission, or HELP for commands."
    );
    return replies;
  }

  replies.push(REGISTRATION_STEPS[regState.index].prompt);
  return replies;
}

// --- Registration state management ---
function registrationState(waId) {
  return registrationStates.get(waId) || { index: 0, answers: {}, started: false };
}
function saveRegistrationState(waId, state) {
  registrationStates.set(waId, state);
}
function clearRegistrationState(waId) {
  registrationStates.delete(waId);
}

// --- Off-topic handling (SOW 2.2) ---
function handleOffTopicOrIdle(waId, replies) {
  const streak = (offTopicStreaks.get(waId) || 0) + 1;
  offTopicStreaks.set(waId, streak);

  if (streak >= 3) {
    offTopicStreaks.set(waId, 0);
    replies.push("It seems you may not need the survey right now. Your session has been paused. Type RESUME when you are ready or contact your supervisor for assistance.");
  } else {
    replies.push("I am a survey bot and can only assist with store visit surveys. Type HELP to see what I can do or START to begin a new survey.");
  }
  return replies;
}

// --- Shared logic for SETTRACK (admin, any agent) and SWITCHTRACK (self) —
// resolves the track argument, applies it, and clears any in-progress
// session so it doesn't mix old/new question sets. Returns the reply string.
async function applyTrackChange(targetWaId, trackArg, targetLabel) {
  const trackKey = trackKeyFromArg(trackArg);
  if (!trackKey) {
    return `Unrecognized track "${trackArg}". Reply with a number or key:\n${trackOptionsPrompt()}`;
  }
  await agentStore.updateAgent(targetWaId, { surveyTrack: trackKey });
  sessionStore.clear(targetWaId);
  return `✅ ${targetLabel} switched to *${trackLabel(trackKey)}*. Any in-progress survey was cleared.`;
}

/**
 * Main entry point. Returns an array of outbound message strings.
 * `message` is a normalized inbound object: { type, text?, location? }
 */
async function handleInboundMessage(waId, message) {
  const replies = [];
  const upper = getRawText(message).trim().toUpperCase();
  const rawText = getRawText(message);

  // --- STOP / opt-out honored immediately (SOW 2.7) ---
  if (upper === "STOP") {
    sessionStore.clear(waId);
    replies.push("You have been unsubscribed and removed from active sessions. Contact your supervisor to re-activate.");
    return replies;
  }

  const agent = await agentStore.getAgent(waId);

  // --- Admin: wipe ALL registered agents + sessions, start fresh ---
  // Two-step so it can't be triggered by accident. Does not touch Sheets
  // submission data — only the Agents tab.
  if (upper === "RESETAGENTS") {
    if (!requireAdmin(waId, replies)) return replies;
    replies.push(
      "⚠️ This will permanently remove ALL registered agents and clear all active sessions. " +
        "Everyone will need to register again (and re-pick their track) the next time they message. " +
        "This does NOT delete anything already saved to Google Sheets submissions.\n\n" +
        "To proceed, reply exactly: RESETAGENTS CONFIRM"
    );
    return replies;
  }
  if (upper === "RESETAGENTS CONFIRM") {
    if (!requireAdmin(waId, replies)) return replies;
    await agentStore.clearAllAgents();
    sessionStore.clearAll();
    registrationStates.clear();
    offTopicStreaks.clear();
    recentSubmissions.clear();
    replies.push(
      "✅ All registered agents and active sessions have been cleared. The bot is starting fresh — " +
        "anyone who messages now (including you) will go through registration again."
    );
    return replies;
  }

  // --- Admin: fix any agent's track remotely (no shell/file access needed) ---
  // Usage: SETTRACK <phone_number> <GT|MT|INSURANCE|1|2|3>
  if (upper.startsWith("SETTRACK ")) {
    if (!requireAdmin(waId, replies)) return replies;
    const parts = rawText.trim().split(/\s+/);
    if (parts.length < 3) {
      replies.push(`Usage: SETTRACK <phone_number> <track>\n${trackOptionsPrompt()}`);
      return replies;
    }
    const [, phoneArg, trackArg] = parts;
    const target = await agentStore.findAgentByPhone(phoneArg);
    if (!target) {
      replies.push(`No registered agent found for ${phoneArg}.`);
      return replies;
    }
    replies.push(await applyTrackChange(target.waId, trackArg, `${target.fullName} (${target.waId})`));
    return replies;
  }

  // --- Registration flow for first-time users (SOW 1.4) ---
  if (!agent) {
    return handleRegistration(waId, message, replies);
  }

  // --- Self-service: check or change your own track ---
  if (upper === "MYTRACK" || upper === "WHOAMI") {
    replies.push(`You're registered as *${agent.fullName}* on the *${trackLabel(agent.surveyTrack || "GT")}* survey.`);
    return replies;
  }
  if (upper.startsWith("SWITCHTRACK ")) {
    const arg = rawText.trim().slice("SWITCHTRACK ".length).trim();
    const message = await applyTrackChange(waId, arg, "Your survey track");
    agent.surveyTrack = trackKeyFromArg(arg) || agent.surveyTrack; // keep local copy in sync for the rest of this turn
    replies.push(message + (message.startsWith("✅") ? " Type START to begin a submission." : ""));
    return replies;
  }

  let session = sessionStore.get(waId);

  // --- Timeout handling (SOW 1.9) ---
  if (session) {
    if (sessionStore.hasTimedOut(session)) {
      sessionStore.pause(session);
      session.status = "timed_out";
      replies.push(`Your session timed out after ${sessionStore.TIMEOUT_MIN} minutes of inactivity. Progress is saved — type RESUME to continue within ${sessionStore.RESUME_HOURS}h.`);
    } else if (sessionStore.needsTimeoutWarning(session)) {
      replies.push("⏰ Reminder: your session will pause soon due to inactivity. Reply to keep it active.");
    }
  }

  // --- RESETAGENT: self-service full deregistration ---
  if (upper === "RESETAGENT") {
    return handleResetAgent(waId, session, replies);
  }

  // --- Global commands ---
  if (GLOBAL_COMMANDS.includes(upper)) {
    handleGlobalCommand(waId, agent, session, upper, replies);
    return replies;
  }

  // --- Admin commands ---
  if (ADMIN_COMMANDS.includes(upper)) {
    if (!requireAdmin(waId, replies)) return replies;
    return handleAdminCommand(upper, replies);
  }

  // --- START a new survey ---
  if (upper === "START") {
    if (session && session.status === "active" && Object.keys(session.answers).length > 0) {
      replies.push("You already have a survey in progress. Type RESUME to continue, SUMMARY to review it, or CANCEL to discard it.");
      return replies;
    }
    session = sessionStore.newSession(waId);
    session.track = agent.surveyTrack || "GT";

    // Phase 1: Stores registry — MT agents pick a known store instead of
    // retyping identity fields every visit, or register a new one.
    if (session.track === "MT") {
      let stores = [];
      try {
        stores = await sheets.readAllStores("MT");
      } catch (err) {
        console.error("Failed to load stores list:", err.message);
      }
      if (stores.length > 0) {
        session.storeFlow = "choosing";
        session.storeChoices = stores;
        replies.push(
          `New ${trackLabel(session.track)} survey started (Ref: ${session.sessionId}).\n\n` +
            "Which store are you visiting?\n" +
            stores.map((s, i) => `${i + 1}. ${s.storeName} (${s.areaLocation})`).join("\n") +
            "\n\nReply with a number, or type NEW to register a new store."
        );
        return replies;
      }
    }

    replies.push(`New ${trackLabel(session.track)} survey started (Ref: ${session.sessionId}). Type HELP any time for commands.\n\n${stepPrompt(currentStep(session), session.answers)}\n\n${progressLine(session)}`);
    return replies;
  }

  if (!session || session.status === "cancelled" || session.status === "submitted") {
    return handleOffTopicOrIdle(waId, replies);
  }

  // Sessions created before a track was assigned default to the agent's track.
  if (!session.track) session.track = agent.surveyTrack || "GT";

  sessionStore.touch(session);

  // --- Store selection flow (Phase 1: Stores registry, MT only) ---
  if (session.storeFlow === "choosing") {
    if (upper === "NEW") {
      session.storeFlow = null;
      session.storeChoices = null;
      replies.push(`${stepPrompt(currentStep(session), session.answers)}\n\n${progressLine(session)}`);
      return replies;
    }
    const idx = Number(rawText.trim());
    const stores = session.storeChoices || [];
    if (!Number.isInteger(idx) || idx < 1 || idx > stores.length) {
      replies.push(`Please reply with a number from 1 to ${stores.length}, or NEW to register a new store.`);
      return replies;
    }
    const chosen = stores[idx - 1];
    Object.assign(session.answers, storeToAnswers(chosen));
    session.storeFlow = null;
    session.storeChoices = null;
    replies.push(`✅ Store selected: *${chosen.storeName}*.\n\n${stepPrompt(currentStep(session), session.answers)}\n\n${progressLine(session)}`);
    return replies;
  }

  // --- SKU pricing loop ---
  if (session.skuLoop) {
    return handleSkuLoop(session, message, upper, replies);
  }

  // --- SUBMIT flow ---
  if (upper === "SUBMIT") {
    return handleSubmit(waId, agent, session, replies);
  }
  if (upper === "CONFIRM" && session.pendingSubmit) {
    return finalizeSubmit(waId, agent, session, replies);
  }

  // --- EDIT flow ---
  if (upper === "EDIT") {
    const steps = activeSteps(session).filter((s) => session.answers[s.key] !== undefined);
    if (steps.length === 0) {
      replies.push("Nothing to edit yet.");
      return replies;
    }
    session.editingField = "choosing";
    replies.push("Which field do you want to edit? Reply with a number:\n" + steps.map((s, i) => `${i + 1}. ${s.label}`).join("\n"));
    return replies;
  }

  if (session.editingField === "choosing") {
    const steps = activeSteps(session).filter((s) => session.answers[s.key] !== undefined);
    const idx = Number(rawText.trim());
    if (!Number.isInteger(idx) || idx < 1 || idx > steps.length) {
      replies.push(`Please reply with a number from 1 to ${steps.length}, or CANCEL.`);
      return replies;
    }
    const target = steps[idx - 1];
    session.editingField = target.key;
    replies.push(`Editing *${target.label}*.\n\n${stepPrompt(target, session.answers)}`);
    return replies;
  }

  // --- BACK ---
  if (upper === "BACK") {
    if (session.backCount >= MAX_BACK) {
      replies.push("You've reached the maximum number of BACK navigations for this survey.");
      return replies;
    }
    if (session.stepIndex === 0) {
      replies.push("You're already at the first question.");
      return replies;
    }
    session.stepIndex -= 1;
    session.backCount += 1;
    const step = currentStep(session);
    replies.push(`${stepPrompt(step, session.answers)}\n\n${progressLine(session)}`);
    return replies;
  }

  // --- SKIP ---
  if (upper === "SKIP") {
    const step = currentStep(session);
    if (!step) {
      replies.push("There's nothing to skip right now.");
      return replies;
    }
    if (step.required) {
      replies.push("This field is required and can't be skipped.");
      return replies;
    }
    session.answers[step.key] = null;
    advance(session);
    replies.push(...promptForCurrentOrSummary(session));
    return replies;
  }

  // --- Process answer to current step ---
  const steps = surveyStepsFor(session);
  const targetKey = session.editingField && session.editingField !== "choosing" ? session.editingField : null;
  const step = targetKey ? steps.find((s) => s.key === targetKey) : currentStep(session);

  if (!step) {
    replies.push('Survey complete. Type SUBMIT to finish, SUMMARY to review, or EDIT to change an answer.');
    return replies;
  }

  const result = processAnswer(step, message, session.answers);

  if (!result.ok) {
    session.retryCount += 1;
    if (session.retryCount >= MAX_RETRIES) {
      if (!step.required) {
        replies.push(`${result.error}\nStill having trouble? Type SKIP to move on, since this field is optional.`);
      } else {
        replies.push(`${result.error}\nThis field is required — it has been flagged for admin follow-up, but let's try once more in a simpler format if possible.`);
      }
      session.retryCount = 0;
    } else {
      replies.push(`${result.error} (Attempt ${session.retryCount}/${MAX_RETRIES})`);
    }
    return replies;
  }

  // Cross-field validation
  let flagNote = null;
  if (step.crossValidate) {
    const cross = step.crossValidate(result.value, session.answers);
    if (cross?.flagged) {
      flagNote = cross.note;
      session.flags = session.flags || [];
      session.flags.push(cross.note);
    }
  }
  if (result.flagged) {
    session.flags = session.flags || [];
    session.flags.push(`Suspicious value entered for ${step.label}.`);
  }

  session.answers[step.key] = result.value;
  session.retryCount = 0;

  if (targetKey) {
    session.editingField = null;
    replies.push(`✅ Updated *${step.label}*.` + (flagNote ? ` (${flagNote})` : ""));
    replies.push("Type SUMMARY to review, or SUBMIT if you're done.");
    return replies;
  }

  // Confirm critical inputs
  const confirmable = ["retailerName", "accountName", "contactName", "contactNumber", "gpsLocation"];
  if (confirmable.includes(step.key)) {
    const display = step.type === "location" ? result.value.address || `${result.value.lat}, ${result.value.lng}` : result.value;
    replies.push(`Got it: *${display}*` + (flagNote ? ` (${flagNote})` : ""));
  } else if (flagNote) {
    replies.push(`Noted. (${flagNote})`);
  }

  // Persist a brand-new MT store to the registry right after its GPS is
  // captured (the last identity field), so it's selectable on future visits.
  if (step.key === "gpsLocation" && session.track === "MT" && !session.answers.storeId) {
    const newStore = {
      storeId: `STORE-${Date.now().toString(36).toUpperCase()}`,
      storeName: session.answers.accountName || "",
      storeType: session.answers.storeType || "",
      areaLocation: session.answers.areaLocation || "",
      gpsLat: result.value.lat ?? "",
      gpsLng: result.value.lng ?? "",
      gpsAddress: result.value.address ?? "",
      gpsSource: result.value.source ?? "",
      contactName: session.answers.contactName || "",
      contactNumber: session.answers.contactNumber || "",
      track: "MT",
      createdAt: new Date().toISOString(),
      createdByAgentWaId: waId,
      createdByAgentName: agent.fullName,
    };
    try {
      await sheets.appendStore(newStore);
      session.answers.storeId = newStore.storeId;
    } catch (err) {
      console.error("Failed to save new store to registry:", err.message);
      // Don't block the survey — the submission still proceeds without a storeId.
    }
  }

  // SKU pricing loop trigger — works for any track whose survey defines a
  // multiselect step with this exact key (see gt.js's productXSkusAvailable).
  if (step.key === "productXSkusAvailable" && Array.isArray(result.value) && result.value.length > 0) {
    session.skuLoop = { skus: result.value, index: 0, field: "ws" };
    replies.push(...promptForSkuLoopOrContinue(session));
    return replies;
  }

  advance(session);
  replies.push(...promptForCurrentOrSummary(session));
  return replies;
}

module.exports = { handleInboundMessage };
