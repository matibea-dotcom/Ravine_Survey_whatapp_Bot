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

async function registerAgent(waId, profile) {
  const agent = { ...profile, waId, registeredAt: new Date().toISOString() };
  await sheets.appendAgent(agent);
  const map = await loadCache();
  map.set(waId, agent);
  return agent;
}

function isAuthorizedAdmin(waId) {
  const admins = (process.env.ADMIN_WA_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(waId);
}

module.exports = { getAgent, registerAgent, isAuthorizedAdmin };
