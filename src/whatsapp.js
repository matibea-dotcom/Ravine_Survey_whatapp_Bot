const axios = require("axios");

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

// SOW 2.7: max 1024 chars per message, break longer content up.
const MAX_MSG_LEN = 1024;

function chunk(text) {
  if (text.length <= MAX_MSG_LEN) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > MAX_MSG_LEN) {
    let cut = remaining.lastIndexOf("\n", MAX_MSG_LEN);
    if (cut < MAX_MSG_LEN * 0.5) cut = MAX_MSG_LEN;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

async function sendText(to, text) {
  const parts = chunk(text);
  for (const part of parts) {
    try {
      await axios.post(
        BASE_URL,
        {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: part, preview_url: false },
        },
        { headers: { Authorization: `Bearer ${TOKEN}` } }
      );
    } catch (err) {
      console.error("Error sending WhatsApp message:", err.response?.data || err.message || err);
      throw err; // Re-throw so caller knows it failed
    }
  }
}

/** Marks an inbound message as read (good practice, not required). */
async function markRead(messageId) {
  try {
    await axios.post(
      BASE_URL,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
  } catch (err) {
    // Non-critical — log but don't throw
    console.warn("Warning: Failed to mark message as read:", err.response?.data || err.message || err);
  }
}

module.exports = { sendText, markRead };
