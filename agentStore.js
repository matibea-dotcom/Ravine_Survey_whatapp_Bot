// Agent registry — backed by a Google Sheets tab ("Agents" by default) so
// registrations survive Render redeploys/restarts (Render's free tier has no
// persistent disk; anything written to the local filesystem is wiped on every
// new deploy or restart). A small in-memory cache avoids hitting the Sheets
// API on every single message.
const sheets = require("./sheets");

let cache = null; // Map<waId, agent> once loaded; null means "not loaded yet"
let bsuidIndex = null; // Map<bsuid, waId> — secondary lookup for the BSUID identity path (see below)
let loadingPromise = null;

function rebuildBsuidIndex(agents) {
  bsuidIndex = new Map();
  for (const a of agents) {
    if (a.bsuid) bsuidIndex.set(a.bsuid, a.waId);
  }
}

async function loadCache() {
  if (cache) return cache;
  if (loadingPromise) return loadingPromise;
  loadingPromise = sheets.readAllAgents().then((agents) => {
    cache = new Map(agents.map((a) => [a.waId, a]));
    rebuildBsuidIndex(agents);
    loadingPromise = null;
    return cache;
  });
  return loadingPromise;
}

async function getAgent(waId) {
  const map = await loadCache();
  return map.get(waId) || null;
}

/**
 * Looks up an agent by whichever identifier the inbound message actually
 * carried — a phone-based waId, a BSUID (Meta's business-scoped user ID,
 * present when a person has hidden their phone number), or both. Tries the
 * phone-based match first since it's the far more common case, then falls
 * back to the BSUID index. See reconcileIdentifiers() below for how an
 * agent's record picks up a second identifier once both are observed.
 */
async function getAgentByAnyId(waId, bsuid) {
  const map = await loadCache();
  if (waId && map.has(waId)) return map.get(waId);
  if (bsuid && bsuidIndex.has(bsuid)) {
    const linkedWaId = bsuidIndex.get(bsuid);
    return map.get(linkedWaId) || null;
  }
  return null;
}

/**
 * If this message carried an identifier the agent's record doesn't have on
 * file yet (most commonly: a BSUID showing up for the first time alongside
 * or instead of their known phone number), persist it — so if this same
 * person's phone number is ever hidden in a later message, getAgentByAnyId
 * can still recognize them via the now-remembered BSUID instead of treating
 * them as a brand-new, unregistered contact.
 *
 * The agent's original waId is never overwritten once set — it stays the
 * stable primary key for their Sheets row. Only the supplementary bsuid
 * field gets filled in when it's missing.
 */
async function reconcileIdentifiers(agent, waId, bsuid) {
  if (!agent || !bsuid || agent.bsuid === bsuid) return agent;
  const updated = await updateAgent(agent.waId, { bsuid });
  if (updated) bsuidIndex.set(bsuid, agent.waId);
  return updated || agent;
}

/**
 * Startup pre-flight check — called once when the server boots (see
 * server.js). Confirms the Agents Google Sheet tab is actually reachable
 * (service account access, sheet ID, network) before the server starts
 * accepting webhook traffic, so misconfiguration fails loudly at deploy
 * time instead of silently on someone's first registration attempt.
 */
async function ensureStorageReady() {
  await loadCache();
}

async function registerAgent(waId, profile) {
  const agent = { ...profile, waId, registeredAt: new Date().toISOString() };
  await sheets.appendAgent(agent);
  const map = await loadCache();
  map.set(waId, agent);
  return agent;
}

/**
 * Patches an existing agent's fields (e.g. surveyTrack) without re-appending
 * a duplicate row. Updates the Sheets backend and the in-memory cache.
 * Returns null if the agent isn't registered.
 */
async function updateAgent(waId, patch) {
  const map = await loadCache();
  const existing = map.get(waId);
  if (!existing) return null;
  const updated = { ...existing, ...patch, waId };
  await sheets.updateAgentRow(updated);
  map.set(waId, updated);
  if (patch.bsuid) bsuidIndex.set(patch.bsuid, waId);
  return updated;
}

/**
 * Looks up an agent by phone number for admin commands (SETTRACK etc.),
 * tolerant of a leading "+" since agents are keyed by the bare WhatsApp id.
 */
async function findAgentByPhone(rawNumber) {
  const digits = String(rawNumber).replace(/[^\d]/g, "");
  return getAgent(digits);
}

/**
 * Clear an agent from the system to allow re-registration.
 * Removes from both the Sheets backend and in-memory cache.
 * (SOW 2.7 extension — allows agents to change survey tracks)
 */
async function clearAgent(waId) {
  try {
    await sheets.deleteAgent(waId);
    const map = await loadCache();
    map.delete(waId);
    for (const [bsuid, linkedWaId] of bsuidIndex) {
      if (linkedWaId === waId) bsuidIndex.delete(bsuid);
    }
    return true;
  } catch (err) {
    console.error("Failed to clear agent:", err.message);
    return false;
  }
}

/**
 * Wipes every registered agent so the bot starts fresh. Does not touch
 * Google Sheets submissions — only the Agents tab. Used by the admin-only
 * RESETAGENTS command (two-step confirm lives in engine.js).
 */
async function clearAllAgents() {
  const map = await loadCache();
  const waIds = [...map.keys()];
  for (const waId of waIds) {
    try {
      await sheets.deleteAgent(waId);
    } catch (err) {
      console.error(`Failed to delete agent ${waId} during clearAllAgents:`, err.message);
    }
  }
  cache = new Map();
  bsuidIndex = new Map();
}

function isAuthorizedAdmin(waId) {
  const admins = (process.env.ADMIN_WA_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(waId);
}

module.exports = {
  getAgent,
  getAgentByAnyId,
  reconcileIdentifiers,
  registerAgent,
  updateAgent,
  findAgentByPhone,
  clearAgent,
  clearAllAgents,
  isAuthorizedAdmin,
  ensureStorageReady,
};
