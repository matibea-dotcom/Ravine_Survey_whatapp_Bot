const sessionStore = require("./sessionStore");
const agentStore = require("./agentStore");
const validators = require("./validators");
const sheets = require("./sheets");
const { REGISTRATION_STEPS, SURVEY_STEPS } = require("./survey");

const MAX_RETRIES = 3;
const MAX_BACK = 5;
const GLOBAL_COMMANDS = [
  "HELP", "BACK", "MENU", "SAVE", "RESUME", "CANCEL", "STATUS",
  "RESTART", "EXIT", "SUMMARY", "STOP", "RESETAGENT",
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

// --- Off-topic detection (reserved for future use / production edge cases) ---
function isOffTopic(text) {
  const t = text.trim().toUpperCase();
  if (GLOBAL_COMMANDS.includes(t) || SURVEY_COMMANDS.includes(t) || ADMIN_COMMANDS.includes(t)) {
    return false;
  }
  return false;
}

// --- Duplicate detection (SOW 2.4) ---
function recordSubmissionForDupeCheck(waId, retailerName) {
  const list = recentSubmissions.get(waId) || [];
  list.push({ retailerName: retailerName.toLowerCase(), at: Date.now() });
  recentSubmissions.set(waId, list.filter((e) => Date.now() - e.at < 24 * 3600 * 1000));
}

function findRecentDuplicate(waId, retailerName) {
  const list = recentSubmissions.get(waId) || [];
  return list.find(
    (e) => e.retailerName === retailerName.toLowerCase() && Date.now() - e.at < 4 * 3600 * 1000
  );
}

// --- Survey step navigation ---
function activeSteps(answers) {
  return SURVEY_STEPS.filter((s) => !(s.skipIf && s.skipIf(answers)));
}

function currentStep(session) {
  const steps = activeSteps(session.answers);
  return steps[session.stepIndex] || null;
}

function stepPrompt(step, answers) {
  return step.promptBuilder ? step.promptBuilder(answers).prompt : step.prompt;
}

function stepOptions(step, answers) {
  return step.promptBuilder ? step.promptBuilder(answers).options : step.options;
}

function progressLine(session) {
  const steps = activeSteps(session.answers);
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
    "RESETAGENT - reset your registration\n" +
    "MENU - show this menu\n" +
    "EXIT - end session"
  );
}

function summaryText(session) {
  const steps = activeSteps(session.answers);
  const lines = steps
    .filter((s) => session.answers[s.key] !== undefined)
    .map((s) => {
      const v = session.answers[s.key];
      const display = Array.isArray(v)
        ? v.join(", ")
        : typeof v === "object" && v !== null
        ? v.address || `${v.lat}, ${v.lng}`
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

// --- SKU Loop (Ravine UHT) ---
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
        sessionStore.touch(session);
        const step = currentStep(session);
        replies.push(`Resuming survey (Ref: ${session.sessionId}).\n\n${stepPrompt(step, session.answers)}\n\n${progressLine(session)}`);
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
    case "RESTART":
      const fresh = sessionStore.newSession(waId);
      replies.push(`Survey restarted (Ref: ${fresh.sessionId}).\n\n${stepPrompt(currentStep(fresh), fresh.answers)}\n\n${progressLine(fresh)}`);
      return;
    case "EXIT":
      if (session) sessionStore.pause(session);
      replies.push("Session ended. Your progress (if any) is saved. Type RESUME or START any time.");
      return;
    default:
      replies.push(helpText(true));
  }
}

// --- Admin command handler ---
async function handleAdminCommand(waId, agent, session, cmd, replies) {
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

// --- Self-service agent reset ---
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
  const missing = SURVEY_STEPS.filter(
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

  const dupe = findRecentDuplicate(waId, session.answers.retailerName);
  if (dupe && !session.dupeConfirmed) {
    replies.push(
      `⚠️ You already submitted a survey for *${session.answers.retailerName}* recently. Is this a new visit?\n` +
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
  
  ["retailerName", "contactName"].forEach((k) => {
    if (session.answers[k] && validators.isGenericTestValue(session.answers[k])) {
      session.flags.push(`Generic/test value detected for ${k}.`);
    }
  });

  const submission = {
    referenceNumber,
    submittedAt: new Date().toISOString(),
    sessionId: session.sessionId,
    agent,
    answers: session.answers,
    flags: session.flags,
  };

  try {
    await sheets.appendSubmission(submission);
    recordSubmissionForDupeCheck(waId, session.answers.retailerName);
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
  const result = validators.validateText(raw, step.opts || { min: 1, max: 50 });
  if (!result.ok) {
    replies.push(result.error);
    return replies;
  }

  regState.answers[step.key] = result.value;
  regState.index += 1;
  saveRegistrationState(waId, regState);

  if (regState.index >= REGISTRATION_STEPS.length) {
    await agentStore.registerAgent(waId, regState.answers);
    clearRegistrationState(waId);
    replies.push(`Thanks, ${regState.answers.fullName}! You're registered. Type START to begin your first store visit survey, or HELP for commands.`);
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

/**
 * Main entry point. Returns an array of outbound message strings.
 * `message` is a normalized inbound object: { type, text?, location? }
 */
async function handleInboundMessage(waId, message) {
  const replies = [];
  const upper = getRawText(message).trim().toUpperCase();

  // --- STOP / opt-out honored immediately (SOW 2.7) ---
  if (upper === "STOP") {
    sessionStore.clear(waId);
    replies.push("You have been unsubscribed and removed from active sessions. Contact your supervisor to re-activate.");
    return replies;
  }

  const agent = await agentStore.getAgent(waId);

  // --- Registration flow for first-time users (SOW 1.4) ---
  if (!agent) {
    return handleRegistration(waId, message, replies);
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

  // --- RESETAGENT: self-service reset ---
  if (upper === "RESETAGENT") {
    return handleResetAgent(waId, session, replies);
  }

  // --- Global commands ---
  if (GLOBAL_COMMANDS.includes(upper) && upper !== "STOP") {
    handleGlobalCommand(waId, agent, session, upper, replies);
    return replies;
  }

  // --- Admin commands ---
  if (ADMIN_COMMANDS.includes(upper)) {
    if (!agentStore.isAuthorizedAdmin(waId)) {
      replies.push("That command is only available to authorized users.");
    } else {
      return handleAdminCommand(waId, agent, session, upper, replies);
    }
    return replies;
  }

  // --- START a new survey ---
  if (upper === "START") {
    if (session && session.status === "active" && Object.keys(session.answers).length > 0) {
      replies.push("You already have a survey in progress. Type RESUME to continue, SUMMARY to review it, or CANCEL to discard it.");
      return replies;
    }
    session = sessionStore.newSession(waId);
    replies.push(`New survey started (Ref: ${session.sessionId}). Type HELP any time for commands.\n\n${stepPrompt(currentStep(session), session.answers)}\n\n${progressLine(session)}`);
    return replies;
  }

  if (!session || session.status === "cancelled" || session.status === "submitted") {
    return handleOffTopicOrIdle(waId, replies);
  }

  sessionStore.touch(session);

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
    const steps = activeSteps(session.answers).filter((s) => session.answers[s.key] !== undefined);
    if (steps.length === 0) {
      replies.push("Nothing to edit yet.");
      return replies;
    }
    session.editingField = "choosing";
    replies.push("Which field do you want to edit? Reply with a number:\n" + steps.map((s, i) => `${i + 1}. ${s.label}`).join("\n"));
    return replies;
  }

  if (session.editingField === "choosing") {
    const steps = activeSteps(session.answers).filter((s) => session.answers[s.key] !== undefined);
    const idx = Number(getRawText(message).trim());
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
  const targetKey = session.editingField && session.editingField !== "choosing" ? session.editingField : null;
  const step = targetKey ? SURVEY_STEPS.find((s) => s.key === targetKey) : currentStep(session);

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
  const confirmable = ["retailerName", "contactName", "contactNumber", "gpsLocation"];
  if (confirmable.includes(step.key)) {
    const display = step.type === "location" ? result.value.address || `${result.value.lat}, ${result.value.lng}` : result.value;
    replies.push(`Got it: *${display}*` + (flagNote ? ` (${flagNote})` : ""));
  } else if (flagNote) {
    replies.push(`Noted. (${flagNote})`);
  }

  // SKU loop trigger
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
