function toTitleCase(str) {
  return str
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isGenericTestValue(str) {
  const s = str.trim().toLowerCase();
  return ["test", "abc", "123", "xxx", "n/a", "na"].includes(s);
}

function validateText(raw, { min = 2, max = 50, titleCase = true } = {}) {
  const trimmed = raw.trim();
  if (trimmed.length < min) {
    return { ok: false, error: `Please enter at least ${min} characters.` };
  }
  if (trimmed.length > max) {
    return { ok: false, error: `Please keep this under ${max} characters.` };
  }
  const value = titleCase ? toTitleCase(trimmed) : trimmed;
  return { ok: true, value, flagged: isGenericTestValue(trimmed) };
}

function validateComments(raw, opts = {}) {
  const trimmed = raw.trim();
  const max = opts.max || 500;
  if (trimmed.length > max) {
    return { ok: false, error: `Comments must be ${max} characters or fewer.` };
  }
  return { ok: true, value: trimmed };
}

function validatePhone(raw) {
  const stripped = raw.replace(/[^\d+]/g, "");
  const digits = stripped.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    return {
      ok: false,
      error: "That doesn't look like a valid phone number. Example: +254712345678",
    };
  }
  if (/^0+$/.test(digits) || /^(\d)\1+$/.test(digits)) {
    return { ok: false, error: "Please enter a real contact number.", flagged: true };
  }
  const formatted = stripped.startsWith("+") ? stripped : `+${digits}`;
  return { ok: true, value: formatted };
}

function validateNumeric(raw, { min = 0, max = null, allowZero = true } = {}) {
  const trimmed = raw.trim();
  // A numeric answer is never legitimately multi-line, or text with
  // several numbers scattered through it -- that's someone answering a
  // different (likely later, free-text) question early. The old version
  // stripped every non-digit character and concatenated whatever digits
  // remained, which silently turned "Kinagop fino\n500ml@61" into 50061
  // and accepted it as a real price -- exactly what happened in a real
  // submission. Require the whole line to BE one number (with an
  // optional currency prefix/suffix like "KES " or "/-"), not just
  // contain one somewhere inside other text.
  if (trimmed.includes("\n")) {
    return { ok: false, error: "Please enter just the number, on one line." };
  }
  const match = trimmed.match(/^[^\d]{0,10}(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)[^\d]{0,10}$/);
  if (!match) {
    return { ok: false, error: "Please enter a numeric value, e.g. 250 or 250.50" };
  }
  const num = Number(match[1].replace(/,/g, ""));
  if (Number.isNaN(num)) {
    return { ok: false, error: "Please enter a numeric value, e.g. 250 or 250.50" };
  }
  if (!allowZero && num <= 0) {
    return { ok: false, error: "Value must be greater than 0." };
  }
  if (num < min) {
    return { ok: false, error: `Value must be at least ${min}.` };
  }
  if (max != null && num > max) {
    return { ok: false, error: `That seems too high — please double-check and re-enter (max ${max}).` };
  }
  return { ok: true, value: num };
}

function validateSelect(raw, options) {
  const idx = Number(raw.trim());
  if (!Number.isInteger(idx) || idx < 1 || idx > options.length) {
    return {
      ok: false,
      error: `Please reply with a number from 1 to ${options.length}.`,
    };
  }
  return { ok: true, value: options[idx - 1], index: idx };
}

function validateMultiSelect(raw, options, { allowNone = false } = {}) {
  const cleaned = raw.trim().toUpperCase();
  if (allowNone && cleaned === "NONE") {
    return { ok: true, value: [] };
  }
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const indices = [];
  for (const p of parts) {
    const idx = Number(p);
    if (!Number.isInteger(idx) || idx < 1 || idx > options.length) {
      return {
        ok: false,
        error: `"${p}" is not valid. Reply with numbers 1-${options.length}, comma or space separated${
          allowNone ? ", or NONE" : ""
        }.`,
      };
    }
    if (!indices.includes(idx)) indices.push(idx);
  }
  if (indices.length === 0) {
    return { ok: false, error: "Please select at least one option." };
  }
  return { ok: true, value: indices.map((i) => options[i - 1]) };
}

function validateLocation(message) {
  if (message.type === "location" && message.location) {
    return {
      ok: true,
      value: {
        lat: message.location.latitude,
        lng: message.location.longitude,
        address: message.location.address || null,
        source: "pin",
        capturedAt: new Date().toISOString(),
      },
    };
  }
  if (message.type === "text" && message.text?.body?.trim().length >= 5) {
    return {
      ok: true,
      value: {
        lat: null,
        lng: null,
        address: message.text.body.trim(),
        source: "manual",
        capturedAt: new Date().toISOString(),
      },
    };
  }
  return {
    ok: false,
    error:
      "Share your location using the WhatsApp \uD83D\uDCCE attachment > Location, or type the store address.",
  };
}

// Lightweight photo capture: records that a photo was sent, its WhatsApp
// media ID (retrievable later via Meta's Graph API if you build the
// download step), MIME type, and caption. Does not download/store the
// actual image.
function validatePhoto(message) {
  if (message.type === "image" && message.image?.id) {
    return {
      ok: true,
      value: {
        mediaId: message.image.id,
        mimeType: message.image.mime_type || null,
        caption: message.image.caption || null,
        receivedAt: new Date().toISOString(),
      },
    };
  }
  return {
    ok: false,
    error: "Please share a photo (use the WhatsApp \uD83D\uDCCE attachment > Camera/Gallery), or type SKIP.",
  };
}

module.exports = {
  toTitleCase,
  isGenericTestValue,
  validateText,
  validateComments,
  validatePhone,
  validateNumeric,
  validateSelect,
  validateMultiSelect,
  validateLocation,
  validatePhoto,
};
