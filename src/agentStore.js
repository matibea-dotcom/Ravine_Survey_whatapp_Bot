// Lightweight file-backed registry so registered agents survive a restart.
// Swap for a real database table (or a Google Sheet "Agents" tab) at scale.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "agents.json");

function ensureStorageReady() {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Check if file exists; if not, create empty agents object
    if (!fs.existsSync(FILE)) {
      fs.writeFileSync(FILE, JSON.stringify({}, null, 2));
    }
  } catch (err) {
    console.error("Error initializing agent storage:", err.response?.data || err.message || err);
    throw err;
  }
}

function load() {
  try {
    ensureStorageReady();
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (err) {
    console.error("Error loading agents from file:", err.response?.data || err.message || err);
    return {};
  }
}

function saveAll(agents) {
  try {
    ensureStorageReady();
    fs.writeFileSync(FILE, JSON.stringify(agents, null, 2));
  } catch (err) {
    console.error("Error saving agents to file:", err.response?.data || err.message || err);
    throw err;
  }
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

module.exports = { getAgent, registerAgent, isAuthorizedAdmin, ensureStorageReady };
