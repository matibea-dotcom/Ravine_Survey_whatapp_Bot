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
// Ravine catalog lookup is MT-specific by design (this pricing-loop feature
// only exists for the MT track's SURVEY_STEPS) — imported directly rather
// than through the generic track registry.
const { RAVINE_SKU_INDEX, RAVINE_CATEGORIES, STOCK_STATUS_OPTIONS: RAVINE_STOCK_STATUS_OPTIONS } = require("./surveys/mt");

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
// Groups stores by a normalized area/location (trimmed, case-folded) so the
// agent picks a location first, then a specific store within it, instead of
// one long flat list. Falls back to "Unspecified" for stores with no area.
function groupStoresByLocation(stores) {
  const groups = new Map(); // normalizedKey -> { label, stores: [] }
  for (const store of stores) {
    const raw = (store.areaLocation || "").trim();
    const key = raw ? raw.toLowerCase() : "__unspecified__";
    if (!groups.has(key)) {
      groups.set(key, { label: raw || "Unspecified Area", stores: [] });
    }
    groups.get(key).stores.push(store);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

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

// Shared by both the direct single-store shortcut and the choosingLocation
// -> choosingStore flow: applies the chosen store's identity fields, checks
// for prior-visit history to offer, and returns the reply text array.
async function selectStoreAndContinue(session, chosen) {
  const replies = [];
  Object.assign(session.answers, storeToAnswers(chosen));
  session.storeChoices = null;
  session.locationChoices = null;

  let lastVisit = null;
  try {
    const rawRecord = await sheets.getLatestSubmissionForStore(chosen.storeId);
    if (rawRecord) lastVisit = sheets.unflattenMtSubmission(rawRecord);
  } catch (err) {
    console.error("Failed to load prior visit for store:", err.message);
  }

  if (lastVisit && Object.keys(lastVisit).length > 0) {
    session.storeFlow = "confirmingHistory";
    session.pendingHistoryAnswers = lastVisit;
    replies.push(
      `📋 This store has a previous visit on record.\n\n` +
        summaryText({ answers: lastVisit, track: session.track }) +
        "\n\nReply CONFIRM to start from these values (you can still EDIT any field before submitting), or type NEW to start blank."
    );
    return replies;
  }

  session.storeFlow = null;
  replies.push(`✅ Store selected: *${chosen.storeName}*.\n\n${stepPrompt(currentStep(session), session.answers)}\n\n${progressLine(session)}`);
  return replies;
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

function advance(session, answeredKey) {
  if (answeredKey) {
    // Use the RAW (unfiltered) step order and count how many steps up to and
    // including the answered one are currently active (using answers AFTER
    // this turn's update). That count is exactly the right stepIndex for
    // "whatever comes next" in the current active list — correct even if
    // answering this step caused it (or others) to newly skip themselves,
    // which a simple "find this key in the filtered list" approach cannot
    // handle (the key may no longer be in that list at all).
    const allSteps = surveyStepsFor(session);
    const rawIdx = allSteps.findIndex((s) => s.key === answeredKey);
    if (rawIdx !== -1) {
      const activeCount = allSteps
        .slice(0, rawIdx + 1)
        .filter((s) => !(s.skipIf && s.skipIf(session.answers))).length;
      session.stepIndex = activeCount;
      return;
    }
  }
  // Fallback for call sites that don't have a step key handy — correct only
  // when no skip-state changed as a result of the answer.
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

  const ravinePricing = session.answers.ravineSkuPricing;
  if (ravinePricing && Object.keys(ravinePricing).length > 0) {
    lines.push(
      ...Object.entries(ravinePricing).map(
        ([sku, p]) => `• ${sku}: WS ${p.wsPerCarton ?? "-"}/carton, Retail ${p.retailPerPiece ?? "-"}/piece${p.source === "manual" ? " (manual)" : ""}`
      )
    );
  }

  const ravineDetails = session.answers.ravineSkuDetails;
  if (ravineDetails && Object.keys(ravineDetails).length > 0) {
    lines.push(
      ...Object.entries(ravineDetails).map(
        ([sku, d]) => `• ${sku}: ${d.facings ?? "-"} facings, ${d.stockStatus ?? "-"}${d.stockStatusNote ? ` (${d.stockStatusNote})` : ""}`
      )
    );
  }

  const competitorPricing = session.answers.competitorPricing;
  if (competitorPricing && Object.keys(competitorPricing).length > 0) {
    const cats = session.answers.competitorCategories || {};
    lines.push(
      ...Object.entries(competitorPricing).map(
        ([brand, p]) => `• ${brand}: Reg ${p.regular ?? "-"}, Promo ${p.promo ?? "-"} [${(cats[brand] || []).join(", ")}]`
      )
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
    advance(session, loop.stepKey);
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

// --- Ravine catalog pricing loop: shows the catalog's recommended wholesale
// (per carton) and retail (per piece) price for each selected SKU; agent
// either confirms it as-is or types an override in one message, instead of
// two separate blank ws/rrp prompts like the generic SKU loop above. ---
function ravineCatalogLookup(sku) {
  return RAVINE_SKU_INDEX[sku] || null;
}

function promptForRavinePriceLoopOrContinue(session) {
  const loop = session.ravinePriceLoop;
  if (loop.index >= loop.skus.length) {
    session.ravinePriceLoop = null;
    advance(session, loop.stepKey);
    return promptForCurrentOrSummary(session);
  }
  const sku = loop.skus[loop.index];
  const entry = ravineCatalogLookup(sku);

  if (loop.stage === "price") {
    if (!entry) {
      // Shouldn't happen (sku came from the catalog-driven options list), but
      // fail safe rather than crash the survey — skip straight to facings.
      session.answers.ravineSkuPricing = session.answers.ravineSkuPricing || {};
      session.answers.ravineSkuPricing[sku] = { wsPerCarton: null, retailPerPiece: null, source: "unavailable" };
      loop.stage = "facings";
      return promptForRavinePriceLoopOrContinue(session);
    }
    return [
      `*${sku}* — recommended: WS KES ${entry.wsPerCarton}/carton, Retail KES ${entry.retailPerPiece}/piece.\n` +
        "Reply CONFIRM to accept these prices, or type new values as *wholesale,retail* (e.g. 600,65) to override.",
    ];
  }
  if (loop.stage === "facings") {
    return [`How many *shelf facings* does *${sku}* have? (numbers only)`];
  }
  if (loop.stage === "stockStatus") {
    return [
      `What is the *stock status* of *${sku}*?\n` +
        RAVINE_STOCK_STATUS_OPTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    ];
  }
  if (loop.stage === "stockStatusNote") {
    return [`You selected 'Other' for *${sku}*'s stock status — please describe it.`];
  }
  return [""]; // unreachable
}

function handleRavinePriceLoop(session, message, upper, replies) {
  const loop = session.ravinePriceLoop;
  const sku = loop.skus[loop.index];
  const entry = ravineCatalogLookup(sku);

  if (["SUBMIT", "EDIT", "BACK"].includes(upper)) {
    replies.push(`Please finish *${sku}*'s details first, then ${upper} again.`);
    return replies;
  }

  session.answers.ravineSkuPricing = session.answers.ravineSkuPricing || {};
  session.answers.ravineSkuDetails = session.answers.ravineSkuDetails || {};
  session.answers.ravineSkuDetails[sku] = session.answers.ravineSkuDetails[sku] || {};

  if (loop.stage === "price") {
    if (upper === "CONFIRM") {
      session.answers.ravineSkuPricing[sku] = {
        wsPerCarton: entry?.wsPerCarton ?? null,
        retailPerPiece: entry?.retailPerPiece ?? null,
        source: "catalog",
      };
    } else {
      const parts = getRawText(message).split(",").map((p) => p.trim());
      if (parts.length !== 2) {
        replies.push('Please reply CONFIRM, or type two numbers as "wholesale,retail" (e.g. 600,65).');
        return replies;
      }
      const ws = validators.validateNumeric(parts[0], { allowZero: false });
      const retail = validators.validateNumeric(parts[1], { allowZero: false });
      if (!ws.ok || !retail.ok) {
        replies.push('Please reply CONFIRM, or type two numbers as "wholesale,retail" (e.g. 600,65).');
        return replies;
      }
      session.answers.ravineSkuPricing[sku] = { wsPerCarton: ws.value, retailPerPiece: retail.value, source: "manual" };
      session.flags = session.flags || [];
      session.flags.push(`${sku}: manual price override entered (catalog: WS ${entry?.wsPerCarton}, Retail ${entry?.retailPerPiece}).`);
    }
    loop.stage = "facings";
    replies.push(...promptForRavinePriceLoopOrContinue(session));
    return replies;
  }

  if (loop.stage === "facings") {
    const result = validators.validateNumeric(getRawText(message), { allowZero: true });
    if (!result.ok) {
      replies.push(result.error);
      return replies;
    }
    session.answers.ravineSkuDetails[sku].facings = result.value;
    loop.stage = "stockStatus";
    replies.push(...promptForRavinePriceLoopOrContinue(session));
    return replies;
  }

  if (loop.stage === "stockStatus") {
    const result = validators.validateSelect(getRawText(message), RAVINE_STOCK_STATUS_OPTIONS);
    if (!result.ok) {
      replies.push(result.error);
      return replies;
    }
    session.answers.ravineSkuDetails[sku].stockStatus = result.value;
    if (result.value === "Other") {
      loop.stage = "stockStatusNote";
      replies.push(...promptForRavinePriceLoopOrContinue(session));
      return replies;
    }
    loop.index += 1;
    loop.stage = "price";
    replies.push(...promptForRavinePriceLoopOrContinue(session));
    return replies;
  }

  if (loop.stage === "stockStatusNote") {
    const result = validators.validateComments(getRawText(message));
    if (!result.ok) {
      replies.push(result.error);
      return replies;
    }
    session.answers.ravineSkuDetails[sku].stockStatusNote = result.value;
    loop.index += 1;
    loop.stage = "price";
    replies.push(...promptForRavinePriceLoopOrContinue(session));
    return replies;
  }

  return replies; // unreachable
}

// --- Competitor brand loop (Phase 3): for each ranked brand, a quick
// category-presence checklist, then one regular price and one promo price.
// (Category x brand pricing would add 25+ more questions — see mt.js.) ---
function expandOtherBrands(rankedBrands, otherNames) {
  const idx = rankedBrands.indexOf("Other");
  if (idx === -1) return rankedBrands;
  return [...rankedBrands.slice(0, idx), ...otherNames, ...rankedBrands.slice(idx + 1)];
}

function startCompetitorLoop(session, brands, stepKey) {
  session.competitorLoop = { brands, brandIndex: 0, stage: "categories", stepKey };
}

function promptForCompetitorLoopOrContinue(session) {
  const loop = session.competitorLoop;
  if (loop.brandIndex >= loop.brands.length) {
    session.competitorLoop = null;
    advance(session, loop.stepKey);
    return promptForCurrentOrSummary(session);
  }
  const brand = loop.brands[loop.brandIndex];
  if (loop.stage === "categories") {
    return [
      `Which *categories* does *${brand}* have products in? Reply with numbers, comma/space separated:\n` +
        RAVINE_CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    ];
  }
  if (loop.stage === "regularPrice") {
    return [`What is *${brand}*'s typical *regular price* (KES)? (numbers only)`];
  }
  if (loop.stage === "promoPrice") {
    return [`Does *${brand}* have a *promotional price* right now? Reply with the amount (KES), or SKIP if none.`];
  }
  return [""]; // unreachable
}

function handleCompetitorLoop(session, message, upper, replies) {
  const loop = session.competitorLoop;
  const brand = loop.brands[loop.brandIndex];

  if (["SUBMIT", "EDIT", "BACK"].includes(upper)) {
    replies.push(`Please finish *${brand}*'s details first, then ${upper} again.`);
    return replies;
  }

  session.answers.competitorCategories = session.answers.competitorCategories || {};
  session.answers.competitorPricing = session.answers.competitorPricing || {};

  if (loop.stage === "categories") {
    const result = validators.validateMultiSelect(getRawText(message), RAVINE_CATEGORIES, { allowNone: false });
    if (!result.ok) {
      replies.push(result.error);
      return replies;
    }
    session.answers.competitorCategories[brand] = result.value;
    loop.stage = "regularPrice";
    replies.push(...promptForCompetitorLoopOrContinue(session));
    return replies;
  }

  if (loop.stage === "regularPrice") {
    const result = validators.validateNumeric(getRawText(message), { allowZero: false });
    if (!result.ok) {
      replies.push(result.error);
      return replies;
    }
    session.answers.competitorPricing[brand] = { regular: result.value, promo: null };
    loop.stage = "promoPrice";
    replies.push(...promptForCompetitorLoopOrContinue(session));
    return replies;
  }

  if (loop.stage === "promoPrice") {
    if (upper === "SKIP") {
      // promo already defaults to null above
    } else {
      const result = validators.validateNumeric(getRawText(message), { allowZero: false });
      if (!result.ok) {
        replies.push(`${result.error} Or type SKIP if there's no promo price.`);
        return replies;
      }
      session.answers.competitorPricing[brand].promo = result.value;
    }
    loop.brandIndex += 1;
    loop.stage = "categories";
    replies.push(...promptForCompetitorLoopOrContinue(session));
    return replies;
  }

  return replies; // unreachable
}

// --- Answer validation ---
function processAnswer(step, message, answers) {
  if (step.type === "location") {
    return validators.validateLocation(message);
  }
  if (step.type === "photo") {
    return validators.validatePhoto(message);
  }
  if (message.type !== "text") {
    return { ok: false, error: "Please reply with text for this question." };
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
    case "REPORT": {
      try {
        const stats = await sheets.computeMtReport();
        if (!stats.totalVisits) {
          replies.push("No MT submissions yet to report on.");
          return replies;
        }
        const pct = (n) => (n == null ? "n/a" : `${Math.round(n * 100)}%`);
        const num = (n, d = 1) => (n == null ? "n/a" : n.toFixed(d));

        const gaps = [
          { label: "availability", gap: stats.stockedPct != null ? 1 - stats.stockedPct : 0, msg: `${pct(stats.stockedPct != null ? 1 - stats.stockedPct : null)} of visited outlets did not stock Ravine` },
          { label: "planogram compliance", gap: stats.planogramPct != null ? 1 - stats.planogramPct : 0, msg: `planogram compliance is only ${pct(stats.planogramPct)}` },
          { label: "POS visibility", gap: stats.posPct != null ? 1 - stats.posPct : 0, msg: `POS material presence is only ${pct(stats.posPct)}` },
        ].sort((a, b) => b.gap - a.gap);
        const priority =
          gaps[0].gap < 0.05
            ? "Priority: no major gaps — availability, planogram, and POS visibility all look strong across visited outlets."
            : `Priority: address ${gaps[0].label} first — ${gaps[0].msg}.`;

        replies.push(
          "📊 *MT Field Report*\n" +
            `Visits: ${stats.totalVisits}\n` +
            `Ravine Stocked: ${pct(stats.stockedPct)} (${stats.stockedYes}/${stats.totalVisits})\n` +
            `Out of Stock (per SKU): ${pct(stats.oosPct)}\n` +
            `Avg Shelf Visibility: ${num(stats.avgVisibility)}/5\n` +
            `Avg Facings: ${num(stats.avgFacings)}\n` +
            `Full Planogram: ${pct(stats.planogramPct)}\n` +
            `POS Materials Present: ${pct(stats.posPct)}\n\n` +
            priority
        );
      } catch (err) {
        console.error("REPORT failed:", err.message);
        replies.push("⚠️ Couldn't generate the report right now. Try again shortly.");
      }
      return replies;
    }
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

  // --- Admin commands (checked before registration gate — an admin
  // shouldn't need to be a registered survey agent to pull a report) ---
  if (ADMIN_COMMANDS.includes(upper)) {
    if (!requireAdmin(waId, replies)) return replies;
    return handleAdminCommand(upper, replies);
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
        const groups = groupStoresByLocation(stores);
        if (groups.length === 1 && groups[0].stores.length === 1) {
          // Only one store total — skip straight to it rather than a
          // one-item menu.
          replies.push(`New ${trackLabel(session.track)} survey started (Ref: ${session.sessionId}).`);
          replies.push(...(await selectStoreAndContinue(session, groups[0].stores[0])));
          return replies;
        }
        session.storeFlow = "choosingLocation";
        session.locationChoices = groups;
        replies.push(
          `New ${trackLabel(session.track)} survey started (Ref: ${session.sessionId}).\n\n` +
            "Which area are you visiting?\n" +
            groups.map((g, i) => `${i + 1}. ${g.label} (${g.stores.length})`).join("\n") +
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

  // --- Store selection flow (Phase 1/5: Stores registry, MT only) ---
  // Step A: pick an area/location.
  if (session.storeFlow === "choosingLocation") {
    if (upper === "NEW") {
      session.storeFlow = null;
      session.locationChoices = null;
      replies.push(`${stepPrompt(currentStep(session), session.answers)}\n\n${progressLine(session)}`);
      return replies;
    }
    const idx = Number(rawText.trim());
    const groups = session.locationChoices || [];
    if (Number.isInteger(idx) && idx >= 1 && idx <= groups.length) {
      const group = groups[idx - 1];
      if (group.stores.length === 1) {
        replies.push(...(await selectStoreAndContinue(session, group.stores[0])));
        return replies;
      }
      session.storeFlow = "choosing";
      session.storeChoices = group.stores;
      session.locationChoices = null;
      replies.push(
        `Which store in *${group.label}*?\n` +
          group.stores.map((s, i) => `${i + 1}. ${s.storeName}`).join("\n") +
          "\n\nReply with a number, or type NEW to register a new store."
      );
      return replies;
    }

    // Not a valid location number — try it as a store-name search instead,
    // across ALL stores regardless of location.
    const query = rawText.trim().toLowerCase();
    if (query.length < 2) {
      replies.push(`Please reply with a number from 1 to ${groups.length}, type NEW to register a new store, or type part of a store name to search.`);
      return replies;
    }
    const allStores = groups.flatMap((g) => g.stores);
    const matches = allStores.filter((s) => s.storeName.toLowerCase().includes(query));
    if (matches.length === 0) {
      replies.push(`No stores matched "${rawText.trim()}". Reply with a location number, NEW, or try a different search term.`);
      return replies;
    }
    if (matches.length === 1) {
      replies.push(...(await selectStoreAndContinue(session, matches[0])));
      return replies;
    }
    const shown = matches.slice(0, 15);
    session.storeFlow = "choosing";
    session.storeChoices = shown;
    session.locationChoices = null;
    replies.push(
      `Found ${matches.length} matching store(s)${matches.length > 15 ? " (showing first 15)" : ""}:\n` +
        shown.map((s, i) => `${i + 1}. ${s.storeName} (${s.areaLocation})`).join("\n") +
        "\n\nReply with a number, or type NEW to register a new store."
    );
    return replies;
  }

  // Step B: pick a specific store within the chosen location (or the direct
  // single-store-total shortcut from START).
  if (session.storeFlow === "choosing") {
    if (upper === "NEW") {
      session.storeFlow = null;
      session.storeChoices = null;
      replies.push(`${stepPrompt(currentStep(session), session.answers)}\n\n${progressLine(session)}`);
      return replies;
    }
    const stores = session.storeChoices || [];
    if (stores.length === 1) {
      // Defensive fallback — choosingLocation already resolves single-store
      // groups directly, so this shouldn't normally be reached.
      replies.push(...(await selectStoreAndContinue(session, stores[0])));
      return replies;
    }
    const idx = Number(rawText.trim());
    if (!Number.isInteger(idx) || idx < 1 || idx > stores.length) {
      replies.push(`Please reply with a number from 1 to ${stores.length}, or NEW to register a new store.`);
      return replies;
    }
    replies.push(...(await selectStoreAndContinue(session, stores[idx - 1])));
    return replies;
  }

  // --- Prior-visit prefill confirmation (Phase 4) ---
  if (session.storeFlow === "confirmingHistory") {
    if (upper === "CONFIRM") {
      Object.assign(session.answers, session.pendingHistoryAnswers);
      session.storeFlow = null;
      session.pendingHistoryAnswers = null;
      session.stepIndex = activeSteps(session).length; // jump straight to the "complete" state
      replies.push(...promptForCurrentOrSummary(session));
      return replies;
    }
    if (upper === "NEW") {
      session.storeFlow = null;
      session.pendingHistoryAnswers = null;
      replies.push(`${stepPrompt(currentStep(session), session.answers)}\n\n${progressLine(session)}`);
      return replies;
    }
    replies.push("Reply CONFIRM to start from last visit's values, or NEW to start blank.");
    return replies;
  }

  // --- SKU pricing loop ---
  if (session.skuLoop) {
    return handleSkuLoop(session, message, upper, replies);
  }
  if (session.ravinePriceLoop) {
    return handleRavinePriceLoop(session, message, upper, replies);
  }
  if (session.competitorLoop) {
    return handleCompetitorLoop(session, message, upper, replies);
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
    advance(session, step.key);
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
    // An edit can retroactively unskip a later field (e.g. changing payment
    // status to overdue un-skips the written-commitment question). Re-land
    // on the first still-unanswered active step so a stale stepIndex can't
    // land on — and silently overwrite — the wrong field on the agent's
    // next message. Same class of bug as the advance() fix, different
    // trigger (EDIT rather than normal forward progression).
    const active = activeSteps(session);
    const firstUnanswered = active.findIndex((s) => s.required && session.answers[s.key] === undefined);
    session.stepIndex = firstUnanswered === -1 ? active.length : firstUnanswered;
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
    session.skuLoop = { skus: result.value, index: 0, field: "ws", stepKey: step.key };
    replies.push(...promptForSkuLoopOrContinue(session));
    return replies;
  }

  // Ravine catalog pricing loop trigger (MT's category-driven SKU selection).
  if (step.key === "skusStocked" && Array.isArray(result.value) && result.value.length > 0) {
    session.ravinePriceLoop = { skus: result.value, index: 0, stage: "price", stepKey: step.key };
    replies.push(...promptForRavinePriceLoopOrContinue(session));
    return replies;
  }

  // Competitor brand loop trigger. Two paths: no "Other" picked -> start
  // right after competitorBrandsRanked; "Other" picked -> start after its
  // name(s) are typed in competitorOtherBrandNames.
  if (
    step.key === "competitorBrandsRanked" &&
    Array.isArray(result.value) &&
    result.value.length > 0 &&
    !result.value.includes("Other")
  ) {
    startCompetitorLoop(session, result.value, step.key);
    replies.push(...promptForCompetitorLoopOrContinue(session));
    return replies;
  }
  if (step.key === "competitorOtherBrandNames") {
    const rankedBrands = session.answers.competitorBrandsRanked || [];
    const otherNames = String(result.value).split(",").map((s) => s.trim()).filter(Boolean);
    const expanded = expandOtherBrands(rankedBrands, otherNames);
    startCompetitorLoop(session, expanded, step.key);
    replies.push(...promptForCompetitorLoopOrContinue(session));
    return replies;
  }

  advance(session, step.key);
  replies.push(...promptForCurrentOrSummary(session));
  return replies;
}

module.exports = { handleInboundMessage };
