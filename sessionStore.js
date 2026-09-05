// In-memory session store.
// Swap this for Redis / a database table in production so state survives
// restarts and works across multiple server instances.

const TIMEOUT_MIN = Number(process.env.SESSION_TIMEOUT_MINUTES || 30);
const WARNING_MIN = Number(process.env.SESSION_WARNING_MINUTES || 25);
const RESUME_HOURS = Number(process.env.SESSION_RESUME_WINDOW_HOURS || 24);

/** @type {Map<string, object>} keyed by WhatsApp number (E.164, no +) */
const sessions = new Map();

function newSession(waId) {
  const now = Date.now();
  const session = {
    waId,
    sessionId: `S-${now}-${Math.floor(Math.random() * 9000 + 1000)}`,
    stepIndex: 0,
    answers: {},
    status: "active", // active | paused | timed_out | submitted | cancelled
    createdAt: now,
    lastActiveAt: now,
    pausedAt: null,
    warned25: false,
    retryCount: 0,
    backCount: 0,
    offTopicStreak: 0,
    editingField: null, // set when EDIT flow is active
  };
  sessions.set(waId, session);
  return session;
}

function get(waId) {
  return sessions.get(waId) || null;
}

function touch(session) {
  session.lastActiveAt = Date.now();
  session.warned25 = false;
  if (session.status === "paused") session.status = "active";
}

function pause(session) {
  session.status = "paused";
  session.pausedAt = Date.now();
}

function isExpiredForResume(session) {
  if (!session.pausedAt && session.status !== "timed_out") return false;
  const ref = session.pausedAt || session.lastActiveAt;
  const hours = (Date.now() - ref) / (1000 * 60 * 60);
  return hours > RESUME_HOURS;
}

function minutesSinceActive(session) {
  return (Date.now() - session.lastActiveAt) / (1000 * 60);
}

function needsTimeoutWarning(session) {
  return (
    session.status === "active" &&
    !session.warned25 &&
    minutesSinceActive(session) >= WARNING_MIN &&
    minutesSinceActive(session) < TIMEOUT_MIN
  );
}

function hasTimedOut(session) {
  return session.status === "active" && minutesSinceActive(session) >= TIMEOUT_MIN;
}

function clear(waId) {
  sessions.delete(waId);
}

function clearAll() {
  sessions.clear();
}

module.exports = {
  newSession,
  get,
  touch,
  pause,
  isExpiredForResume,
  needsTimeoutWarning,
  hasTimedOut,
  clear,
  clearAll,
  TIMEOUT_MIN,
  WARNING_MIN,
  RESUME_HOURS,
};
