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

function validateComments(raw) {
  const trimmed = raw.trim();
  if (trimmed.length > 500) {
    return { ok: false, error: "Comments must be 500 characters or fewer." };
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

function validateNumeric(raw, { min = 0, allowZero = true } = {}) {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const num = Number(cleaned);
  if (cleaned === "" || Number.isNaN(num)) {
    return { ok: false, error: "Please enter a numeric value, e.g. 250 or 250.50" };
  }
  if (!allowZero && num <= 0) {
    return { ok: false, error: "Value must be greater than 0." };
  }
  if (num < min) {
    return { ok: false, error: `Value must be at least ${min}.` };
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
          allowNone ? ', or NONE' : ""
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
  // WhatsApp sends a `location` message type for a shared pin.
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
  // Fallback: manual typed address.
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
};
