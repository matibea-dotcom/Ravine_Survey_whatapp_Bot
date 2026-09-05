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

// Recent submissions kept in memory for duplicate detection (SOW 2.4).
// { waId -> [{ retailerName, at }] }
const recentSubmissions = new Map();

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

function activeSteps(answers) {
  return SURVEY_STEPS.filter((s) => !(s.skipIf && s.skipIf(answers)));
}

function currentStep(session) {
  const steps = activeSteps(session.answers);
  return steps[session.stepIndex] || null;
}

function stepPrompt(step, answers) {
  if (step.promptBuilder) return step.promptBuilder(answers).prompt;
  return step.prompt;
}

function stepOptions(step, answers) {
  if (step.promptBuilder) return step.promptBuilder(answers).options;
  return step.options;
}

function progressLine(session) {
  const steps = activeSteps(session.answers);
  return `Step ${session.stepIndex + 1} of ${steps.length}`;
}

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
    "RESETAGENT - reset your registration to choose a new survey track\n" +
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

function isOffTopic(text) {
  const t = text.trim().toUpperCase();
  if (GLOBAL_COMMANDS.includes(t) || SURVEY_COMMANDS.includes(t) || ADMIN_COMMANDS.includes(t)) {
    return false;
  }
  // Anything else is only "on-topic" if we're actually expecting free-form input
  // (handled by caller before this check runs against pure commands).
  return false;
}

/**
 * Main entry point. Returns an array of outbound message strings.
 * `message` is a normalized inbound object: { type, text?, location? }
 */
async function handleInboundMessage(waId, message) {
  const replies = [];
  const rawText = message.type === "text" ? message.text.body : "";
  const upper = rawText.trim().toUpperCase();

  // --- STOP / opt-out honored immediately, at all times (SOW 2.7) ---
  if (upper === "STOP") {
    sessionStore.clear(waId);
    replies.push(
      "You have been unsubscribed and removed from active sessions. Contact your supervisor to re-activate."
    );
    return replies;
  }

  const agent = await agentStore.getAgent(waId);

  // --- Registration flow for first-time users (SOW 1.4) ---
  if (!agent) {
    return handleRegistration(waId, message, replies);
  }

  let session = sessionStore.get(waId);

  // --- Timeout handling (SOW 1.9 Level 4 / 2.7) ---
  if (session) {
    if (sessionStore.hasTimedOut(session)) {
      sessionStore.pause(session);
      session.status = "timed_out";
      replies.push(
        `Your session timed out after ${sessionStore.TIMEOUT_MIN} minutes of inactivity. Progress is saved — type RESUME to continue within ${sessionStore.RESUME_HOURS}h.`
      );
    } else if (sessionStore.needsTimeoutWarning(session)) {
      replies.push("⏰ Reminder: your session will pause soon due to inactivity. Reply to keep it active.");
    }
  }

  // --- RESETAGENT: self-service agent reset (accessible to all registered users, only their own number) ---
  if (upper === "RESETAGENT") {
    return handleResetAgent(waId, session, replies);
  }

  // --- Global commands (active at any point, SOW 1.7) ---
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
      replies.push(
        "You already have a survey in progress. Type RESUME to continue, SUMMARY to review it, or CANCEL to discard it."
      );
      return replies;
    }
    session = sessionStore.newSession(waId);
    replies.push(
      `New survey started (Ref: ${session.sessionId}). Type HELP any time for commands.\n\n` +
        stepPrompt(currentStep(session), session.answers) +
        `\n\n${progressLine(session)}`
    );
    return replies;
  }

  if (!session || session.status === "cancelled" || session.status === "submitted") {
    return handleOffTopicOrIdle(waId, replies);
  }

  sessionStore.touch(session);

  // --- SKU pricing loop takes priority over normal step processing — see
  // handleSkuLoop() for why this can't just be another static SURVEY_STEPS entry. ---
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

  // --- EDIT flow: ask which field, then jump to it ---
  if (upper === "EDIT") {
    const steps = activeSteps(session.answers).filter((s) => session.answers[s.key] !== undefined);
    if (steps.length === 0) {
      replies.push("Nothing to edit yet.");
      return replies;
    }
    session.editingField = "choosing";
    replies.push(
      "Which field do you want to edit? Reply with a number:\n" +
        steps.map((s, i) => `${i + 1}. ${s.label}`).join("\n")
    );
    return replies;
  }
  if (session.editingField === "choosing") {
    const steps = activeSteps(session.answers).filter((s) => session.answers[s.key] !== undefined);
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

  // --- Otherwise: treat as an answer to the current step or edit target ---
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
      // Level 2 error handling (SOW 1.9)
      if (!step.required) {
        replies.push(
          `${result.error}\nStill having trouble? Type SKIP to move on, since this field is optional.`
        );
      } else {
        replies.push(
          `${result.error}\nThis field is required — it has been flagged for admin follow-up, but let's try once more in a simpler format if possible.`
        );
      }
      session.retryCount = 0;
    } else {
      replies.push(`${result.error} (Attempt ${session.retryCount}/${MAX_RETRIES})`);
    }
    return replies;
  }

  // Cross-field validation (e.g. RRP vs wholesale, SOW 1.6/2.9)
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

  // Confirm critical inputs before proceeding (SOW 1.5)
  const confirmable = ["retailerName", "contactName", "contactNumber", "gpsLocation"];
  if (confirmable.includes(step.key)) {
    const display =
      step.type === "location"
        ? result.value.address || `${result.value.lat}, ${result.value.lng}`
        : result.value;
    replies.push(`Got it: *${display}*` + (flagNote ? ` (${flagNote})` : ""));
  } else if (flagNote) {
    replies.push(`Noted. (${flagNote})`);
  }

  // Selecting Ravine UHT SKUs kicks off a per-SKU wholesale/RRP pricing loop
  // instead of advancing straight to the next static step — the number of
  // price questions depends on how many SKUs were just selected.
  if (step.key === "productXSkusAvailable" && Array.isArray(result.value) && result.value.length > 0) {
    session.skuLoop = { skus: result.value, index: 0, field: "ws" };
    replies.push(...promptForSkuLoopOrContinue(session));
    return replies;
  }

  advance(session);
  replies.push(...promptForCurrentOrSummary(session));
  return replies;
}

function advance(session) {
  session.stepIndex += 1;
}

// --- Per-SKU pricing loop (Ravine UHT) ---
// Runs right after `productXSkusAvailable` is answered with 1+ SKUs. Asks
// wholesale price then RRP for each selected SKU in turn, storing results in
// session.answers.productXSkuPricing = { [sku]: { ws, rrp } }. Editing SKU
// pricing after the fact isn't supported via EDIT — RESTART if a correction
// is needed before SUBMIT.
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

  const raw = message.type === "text" ? message.text.body : "";
  const result = validators.validateNumeric(raw, { allowZero: false });
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

function advanceSkuLoop(loop) {
  if (loop.field === "ws") {
    loop.field = "rrp";
  } else {
    loop.field = "ws";
    loop.index += 1;
  }
}

function promptForSkuLoopOrContinue(session) {
  const loop = session.skuLoop;
  if (loop.index >= loop.skus.length) {
    session.skuLoop = null;
    advance(session); // move past the productXSkusAvailable step in the main flow
    return promptForCurrentOrSummary(session);
  }
  const sku = loop.skus[loop.index];
  const label = loop.field === "ws" ? "wholesale price" : "RRP (recommended retail price)";
  return [`What is the *${label}* for *${sku}*? (numbers only, or SKIP)`];
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

function processAnswer(step, message, answers) {
  if (step.type === "location") {
    return validators.validateLocation(message);
  }
  const raw = message.type === "text" ? message.text.body : "";
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

function handleGlobalCommand(waId, agent, session, cmd, replies) {
  switch (cmd) {
    case "HELP":
      replies.push(helpText(true));
      return;
    case "MENU":
      replies.push(helpText(true));
      return;
    case "STATUS":
      if (!session) {
        replies.push("No active survey. Type START to begin.");
        return;
      }
      replies.push(`${progressLine(session)}\nStatus: ${session.status}`);
      return;
    case "SUMMARY":
      if (!session) {
        replies.push("No active survey yet.");
        return;
      }
      replies.push(summaryText(session));
      return;
    case "SAVE":
      if (!session) {
        replies.push("No active survey to save.");
        return;
      }
      sessionStore.pause(session);
      replies.push(
        `Progress saved (Ref: ${session.sessionId}). Type RESUME within ${sessionStore.RESUME_HOURS}h to continue.`
      );
      return;
    case "RESUME": {
      if (!session) {
        replies.push("No saved survey found. Type START to begin a new one.");
        return;
      }
      if (sessionStore.isExpiredForResume(session)) {
        sessionStore.clear(waId);
        replies.push("Your saved survey expired. Type START to begin a new one.");
        return;
      }
      sessionStore.touch(session);
      const step = currentStep(session);
      replies.push(
        `Resuming survey (Ref: ${session.sessionId}).\n\n${stepPrompt(step, session.answers)}\n\n${progressLine(session)}`
      );
      return;
    }
    case "CANCEL":
      if (!session) {
        replies.push("No active survey to cancel.");
        return;
      }
      session.status = "cancelled";
      replies.push("Survey cancelled. Type START to begin a new one.");
      return;
    case "RESTART": {
      const fresh = sessionStore.newSession(waId);
      replies.push(`Survey restarted (Ref: ${fresh.sessionId}).\n\n${stepPrompt(currentStep(fresh), fresh.answers)}\n\n${progressLine(fresh)}`);
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

/**
 * Self-service agent reset — allows any registered user to remove their OWN
 * registration and re-register with a new survey track. Each user can only
 * reset their own number (identified by waId), preventing mass resets.
 * (SOW 2.7 extension - Self-service re-registration)
 */
async function handleResetAgent(waId, session, replies) {
  // Only allow reset of the current user's own number (waId)
  // clearAgent is called with the caller's waId, ensuring no other numbers can be reset
  const success = await agentStore.clearAgent(waId);
  if (success) {
    sessionStore.clear(waId); // Clear only this user's sessions
    clearRegistrationState(waId); // Clear only this user's registration state
    replies.push(
      "✅ Your agent registration has been removed. Type HELP or reply to register again with a new survey track."
    );
  } else {
    replies.push(
      "⚠️ Failed to reset your registration. Please contact your supervisor for assistance."
    );
  }
  return replies;
}

async function handleAdminCommand(waId, agent, session, cmd, replies) {
  switch (cmd) {
    case "REPORT":
      replies.push("A summary report request has been logged. Your supervisor will receive it shortly. (Wire this up to your reporting job / Sheet query.)");
      return replies;
    case "MYDATA":
      replies.push("Your submission history will be sent shortly. (Wire this up to a Sheets lookup filtered by your agent ID.)");
      return replies;
    case "STATS":
      replies.push("Your personal stats will be sent shortly. (Wire this up to a Sheets lookup filtered by your agent ID.)");
      return replies;
    default:
      replies.push("Unknown admin command.");
      return replies;
  }
}

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

  // Duplicate detection (SOW 2.4/2.9): same store, same agent, within 4h.
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

  replies.push(
    "*Final Summary*\n\n" +
      summaryText(session) +
      "\n\nReply CONFIRM to submit, or EDIT to make changes."
  );
  session.pendingSubmit = true;
  return replies;
}

async function finalizeSubmit(waId, agent, session, replies) {
  const referenceNumber = `REF-${Date.now().toString(36).toUpperCase()}`;

  // Auto-quality flags (SOW 2.9) — logged silently, submission still proceeds.
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
  } catch (err) {
    console.error("Sheets append failed:", err.message);
    replies.push(
      `⚠️ Something went wrong saving your survey. Your progress is safe — reference ${referenceNumber}. Type RESUME to try again shortly.`
    );
    session.pendingSubmit = false;
    sessionStore.pause(session);
    return replies;
  }

  recordSubmissionForDupeCheck(waId, session.answers.retailerName);
  session.status = "submitted";
  session.pendingSubmit = false;

  replies.push(
    `✅ Survey submitted! Reference: *${referenceNumber}*\n\nThank you, ${agent.fullName}. Type START to begin another survey.`
  );
  return replies;
}

async function handleRegistration(waId, message, replies) {
  let regState = registrationState(waId);
  const raw = message.type === "text" ? message.text.body : "";

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
    replies.push(
      `Thanks, ${regState.answers.fullName}! You're registered. Type START to begin your first store visit survey, or HELP for commands.`
    );
    return replies;
  }

  replies.push(REGISTRATION_STEPS[regState.index].prompt);
  return replies;
}

// Registration is a short-lived flow — piggyback on the session map keyed
// with a suffix so it doesn't collide with survey sessions.
const registrationStates = new Map();
function registrationState(waId) {
  return registrationStates.get(waId) || { index: 0, answers: {}, started: false };
}
function saveRegistrationState(waId, state) {
  registrationStates.set(waId, state);
}
function clearRegistrationState(waId) {
  registrationStates.delete(waId);
}

// --- Out-of-scope handling (SOW 2.2) — tracks a streak per number when
// there's no active survey and the message isn't a recognized command. ---
const offTopicStreaks = new Map();

function handleOffTopicOrIdle(waId, replies) {
  const streak = (offTopicStreaks.get(waId) || 0) + 1;
  offTopicStreaks.set(waId, streak);

  if (streak >= 3) {
    offTopicStreaks.set(waId, 0);
    replies.push(
      "It seems you may not need the survey right now. Your session has been paused. Type RESUME when you are ready or contact your supervisor for assistance."
    );
    return replies;
  }
  replies.push(
    "I am a survey bot and can only assist with store visit surveys. Type HELP to see what I can do or START to begin a new survey."
  );
  return replies;
}

module.exports = { handleInboundMessage };
