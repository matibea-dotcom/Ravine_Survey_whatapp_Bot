// Lightweight file-backed registry so registered agents survive a restart.
// Swap for a real database table (or a Google Sheet "Agents" tab) at scale.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "agents.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function saveAll(agents) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(agents, null, 2));
}

function getAgent(waId) {
  const agents = load();
  return agents[waId] || null;
}

function registerAgent(waId, profile) {
  const agents = load();
  agents[waId] = { ...profile, waId, registeredAt: new Date().toISOString() };
  saveAll(agents);
  return agents[waId];
}

function isAuthorizedAdmin(waId) {
  const admins = (process.env.ADMIN_WA_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(waId);
}

module.exports = { getAgent, registerAgent, isAuthorizedAdmin };
