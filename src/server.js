require("dotenv").config();
const express = require("express");
const whatsapp = require("./whatsapp");
const engine = require("./engine");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// ---- Webhook verification (Meta requirement) ----
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- Rate limiting / flood detection (SOW 2.4) ----
const MAX_MSGS_PER_MIN = 30;
const FLOOD_WINDOW_MS = 10_000;
const FLOOD_THRESHOLD = 5;
const FLOOD_PAUSE_MS = 2 * 60_000;

const messageTimestamps = new Map(); // waId -> number[]
const floodPausedUntil = new Map(); // waId -> timestamp
const seenMessageIds = new Set(); // dedupe WhatsApp retries

function isRateLimited(waId) {
  const now = Date.now();
  const timestamps = (messageTimestamps.get(waId) || []).filter((t) => now - t < 60_000);
  timestamps.push(now);
  messageTimestamps.set(waId, timestamps);

  const recentFlood = timestamps.filter((t) => now - t < FLOOD_WINDOW_MS);
  if (recentFlood.length >= FLOOD_THRESHOLD) {
    floodPausedUntil.set(waId, now + FLOOD_PAUSE_MS);
    return { limited: true, reason: "flood" };
  }
  if (timestamps.length > MAX_MSGS_PER_MIN) {
    return { limited: true, reason: "rate" };
  }
  const pausedUntil = floodPausedUntil.get(waId);
  if (pausedUntil && now < pausedUntil) {
    return { limited: true, reason: "paused" };
  }
  return { limited: false };
}

// ---- Basic content guardrail: offensive language keyword screen (SOW 2.3) ----
// Replace with a proper moderation service/list for production use.
const OFFENSIVE_TERMS = (process.env.OFFENSIVE_TERMS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function containsOffensiveContent(text) {
  const lower = text.toLowerCase();
  return OFFENSIVE_TERMS.some((term) => term && lower.includes(term));
}

function normalizeInboundMessage(raw) {
  if (raw.type === "text") {
    return { type: "text", text: { body: raw.text.body } };
  }
  if (raw.type === "location") {
    return { type: "location", location: raw.location };
  }
  // Unsupported types (image, audio/voice note, video, document, etc.)
  return { type: "unsupported" };
}

app.post("/webhook", async (req, res) => {
  // Acknowledge immediately — WhatsApp expects a fast 200.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;
    if (!messages || messages.length === 0) return; // e.g. a status update, ignore

    for (const raw of messages) {
      if (seenMessageIds.has(raw.id)) continue;
      seenMessageIds.add(raw.id);

      const waId = raw.from;
      await whatsapp.markRead(raw.id);

      const rl = isRateLimited(waId);
      if (rl.limited) {
        if (rl.reason === "flood") {
          await whatsapp.sendText(
            waId,
            "You're sending messages too quickly. The bot is pausing for 2 minutes — your progress is saved."
          );
        }
        // Silently drop further messages while paused/rate-limited.
        continue;
      }

      if (raw.type === "text" && containsOffensiveContent(raw.text.body)) {
        await whatsapp.sendText(
          waId,
          "⚠️ Please keep messages respectful. This has been logged. Repeated violations will be escalated to your supervisor."
        );
        continue;
      }

      const normalized = normalizeInboundMessage(raw);
      if (normalized.type === "unsupported") {
        await whatsapp.sendText(
          waId,
          "I can only process text replies and shared locations. Please type your answer or share a location pin."
        );
        continue;
      }

      const replies = await engine.handleInboundMessage(waId, normalized);
      for (const reply of replies) {
        await whatsapp.sendText(waId, reply);
      }
    }
  } catch (err) {
    console.error("Webhook handling error:", err);
  }
});

app.get("/", (_req, res) => res.send("WhatsApp Retail Survey Bot is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Survey bot listening on port ${PORT}`));
