// Campaign source tags for the insurance (PRULife) survey.
//
// Every campaign link and QR code pre-fills the chat with PRULIFE plus a short
// channel tag, e.g.  PRULIFE-IG  (Instagram).  The tag is read from the
// client's first message and stored in the sheet's "source" column, so you can
// see which channel each completed survey came from.
//
//   PRULIFE-WA  WhatsApp Status      PRULIFE-FB  Facebook
//   PRULIFE-IG  Instagram            PRULIFE-TT  TikTok
//   PRULIFE-QR  QR code (print / other places)
//
// Any other short tag (letters/digits, up to 12) is accepted and stored as
// typed, in capitals - handy for one-off placements, e.g. PRULIFE-FLYER2.
// A plain PRULIFE, or any message with no tag, is recorded as "Direct".

const KNOWN = {
  WA: "WhatsApp Status",
  STATUS: "WhatsApp Status",
  WS: "WhatsApp Status",
  IG: "Instagram",
  INSTA: "Instagram",
  INSTAGRAM: "Instagram",
  FB: "Facebook",
  FACEBOOK: "Facebook",
  TT: "TikTok",
  TIKTOK: "TikTok",
  QR: "QR code",
};
const DIRECT = "Direct";

// The WHOLE message is a campaign entry: "PRULIFE", "PRULIFE-IG", "prulife ig"
const ENTRY_RE = /^\s*PRULIFE(?:\s*[-_ ]\s*([A-Z0-9]{1,12}))?\s*[.!]?\s*$/i;
// A tag inside a longer first message, e.g. "Hi PRULIFE-TT"
const INLINE_RE = /\bPRULIFE\s*[-_]\s*([A-Z0-9]{1,12})\b/i;

function labelFor(tag) {
  if (!tag) return DIRECT;
  const t = String(tag).toUpperCase();
  return KNOWN[t] || t;
}

/** { tag, source } when the whole message is a campaign entry, otherwise null. */
function parseEntry(text) {
  const m = ENTRY_RE.exec(String(text || ""));
  if (!m) return null;
  const tag = m[1] ? m[1].toUpperCase() : "";
  return { tag, source: labelFor(tag) };
}

/** The source label for a first message (lenient: finds a tag anywhere in it). */
function parseSource(text) {
  const e = parseEntry(text);
  if (e) return e.source;
  const m = INLINE_RE.exec(String(text || ""));
  return m ? labelFor(m[1]) : DIRECT;
}

module.exports = { parseEntry, parseSource, labelFor, KNOWN, DIRECT };
