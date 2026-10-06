// Funnel log for the insurance (PRULife) survey: how many people START, agree
// to the consent question, finish, decline, or turn out to be ineligible -
// per campaign channel. Written to the "Insurance_Events" tab; the "Campaign
// Funnel" tab (apps-script/setup_campaign_funnel.gs) summarises it.
//
// PRIVACY: the very first question is consent, and a person who declines is
// told nothing has been saved. So events NEVER contain a phone number, name or
// any answer - only a time, a random session id, the channel and the stage.
//
// Events are batched and sent about every 5 seconds in ONE Sheets call (a
// campaign burst would otherwise hit Google's per-minute write limit). Logging
// is strictly best-effort: it can never delay, fail or change a survey.

const sheets = require("./sheets");

const FLUSH_MS = Math.max(1, Number(process.env.EVENT_FLUSH_SECONDS || 5)) * 1000;
const MAX_QUEUE = 2000; // memory guard if Sheets is unreachable for a long time
const MAX_TRIES = 3;

let queue = [];
let timer = null;

// "2026-10-06 09:24:27" (UTC, same style as the other date columns)
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function arm() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_MS);
  if (timer.unref) timer.unref(); // never keep the process alive just for this
}

/** event: STARTED | CONSENTED | DECLINED | INELIGIBLE | SUBMITTED */
function log(session, event, extra = {}) {
  try {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({
      eventAt: stamp(),
      sessionId: session.sessionId,
      source: session.source || "Direct",
      event,
      referenceNumber: extra.referenceNumber || "",
      _tries: 0,
    });
    arm();
  } catch (err) {
    console.error("Insurance funnel log error (non-blocking):", err.message);
  }
}

/** Sends everything queued so far. Never throws. */
async function flush() {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    await sheets.appendInsuranceEvents(batch.map(({ _tries, ...e }) => e));
  } catch (err) {
    console.error("Insurance funnel log failed (will retry):", err.message);
    const retry = batch.filter((e) => ++e._tries < MAX_TRIES);
    queue = retry.concat(queue).slice(-MAX_QUEUE);
    if (queue.length > 0) arm();
  }
}

module.exports = { log, flush, _pending: () => queue.length };
