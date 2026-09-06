// Agent registry — backed by a Google Sheets tab ("Agents" by default) so
// registrations survive Render redeploys/restarts (Render's free tier has no
// persistent disk; anything written to the local filesystem is wiped on every
// new deploy or restart). A small in-memory cache avoids hitting the Sheets
// API on every single message.
const sheets = require("./sheets");

let cache = null; // Map<waId, agent> once loaded; null means "not loaded yet"
let loadingPromise = null;

async function loadCache() {
  if (cache) return cache;
  if (loadingPromise) return loadingPromise;
  loadingPromise = sheets.readAllAgents().then((agents) => {
    cache = new Map(agents.map((a) => [a.waId, a]));
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
}

function isAuthorizedAdmin(waId) {
  const admins = (process.env.ADMIN_WA_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(waId);
}

module.exports = {
  getAgent,
  registerAgent,
  updateAgent,
  findAgentByPhone,
  clearAgent,
  clearAllAgents,
  isAuthorizedAdmin,
  ensureStorageReady,
};
