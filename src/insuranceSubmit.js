// Submission handling for the insurance (PRULife) track. Kept out of
// engine.js so the GT/MT submit path is untouched: engine.js calls into
// here only when session.track === "INSURANCE".

const sheets = require("./sheets");
const alerts = require("./alerts");
const insurance = require("./surveys/insurance");
const { kes } = insurance.helpers;

function newReference() {
  return `PRU-${Date.now().toString(36).toUpperCase()}`;
}

// The proposer isn't a registered agent, so the sheet's agent* columns are
// not used for this track — identity lives in the survey's own columns.
function proposerAsAgent(waId, answers) {
  return { waId, fullName: answers.fullName || "", agentId: "", region: "", companyName: "" };
}

function firstName(full) {
  return String(full || "").trim().split(/\s+/)[0] || "there";
}

/**
 * A submitted, eligible survey: compute derived fields + flags, link it to
 * an earlier submission from the same number if there is one, save the row,
 * fire the team alerts, and reply to the proposer.
 */
async function finalizeInsuranceSubmit({ waId, session, replies, sessionStore }) {
  const referenceNumber = newReference();
  session.flags = session.flags || [];

  const elapsedMin = (Date.now() - session.createdAt) / 60000;
  if (elapsedMin < 1.5) session.flags.push("Survey completed in under 90 seconds.");

  const derived = insurance.computeDerived(session.answers, { waId });
  const flags = [...session.flags, ...derived.flags];

  // Revision tracking: same number submitting again links back to the last
  // one, so the team can see the earlier request was replaced, not duplicated.
  let revisionNumber = 1;
  let revisionOf = "";
  try {
    const prior = await sheets.getLatestInsuranceSubmissionByPhone(waId);
    if (prior) {
      revisionNumber = (Number(prior.revisionNumber) || 1) + 1;
      revisionOf = prior.referenceNumber;
    }
  } catch (err) {
    console.error("Insurance revision lookup failed (non-blocking):", err.message);
  }

  const answers = { ...session.answers, ...derived.fields, revisionNumber, revisionOf };
  const submission = {
    referenceNumber,
    submittedAt: new Date().toISOString(),
    sessionId: session.sessionId,
    track: "INSURANCE",
    agent: proposerAsAgent(waId, answers),
    answers,
    flags,
  };

  try {
    await sheets.appendSubmission(submission);
  } catch (err) {
    console.error("Insurance sheet append failed:", err.message);
    replies.push(`⚠️ Something went wrong saving your details. Your answers are safe — please type SUBMIT again in a moment. (Ref: ${referenceNumber})`);
    session.pendingSubmit = false;
    sessionStore.pause(session);
    return replies;
  }

  session.status = "submitted";
  session.pendingSubmit = false;

  // Alerts are best-effort and must never undo or delay the saved survey.
  alerts.sendInsuranceAlert(submission).catch((err) => console.error("Insurance alert error:", err.message));

  const lines = [`✅ Thank you, ${firstName(answers.fullName)}! Your details have been received. Reference: *${referenceNumber}*`];
  lines.push("Our team will prepare your PRULife quote and share it with you shortly.");
  if (answers.medicalRequired === "Yes") lines.push("Because of the cover amount, a medical examination will be needed — we'll guide you on that.");
  if (answers.specialClearance === "Yes") lines.push("Cover at this level needs special approval from the insurer, so our team will contact you personally.");
  lines.push("If anything changes, just type START and fill the survey in again — we'll use your latest answers.");
  replies.push(lines.join("\n\n"));
  return replies;
}

/**
 * Survey ended early by a step's endIf (declined consent, or age outside
 * 18-60). `end.save` decides whether a row is kept: a declined consent saves
 * nothing at all; an age-ineligible attempt is saved as INELIGIBLE (no
 * alert) so the team can see demand they couldn't serve.
 */
async function endInsuranceEarly({ waId, session, end, replies, sessionStore }) {
  if (end.save) {
    try {
      const referenceNumber = newReference();
      const derived = insurance.computeDerived(session.answers, { waId });
      const answers = { ...session.answers, ...derived.fields, status: end.status || "INELIGIBLE" };
      await sheets.appendSubmission({
        referenceNumber,
        submittedAt: new Date().toISOString(),
        sessionId: session.sessionId,
        track: "INSURANCE",
        agent: proposerAsAgent(waId, answers),
        answers,
        flags: [...(session.flags || []), `${answers.status}: age ${answers.ageAtSubmission} is outside 18-60`],
      });
    } catch (err) {
      console.error("Saving early-ended insurance survey failed (non-blocking):", err.message);
    }
  }
  session.status = "cancelled";
  sessionStore.clear(waId);
  replies.push(end.message);
  return replies;
}

module.exports = { finalizeInsuranceSubmit, endInsuranceEarly, kes };
