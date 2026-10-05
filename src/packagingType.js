// Classifies free text by dairy PACKAGING TYPE (ESL, Fino, UHT, Lala
// Pouch/Bottle, Yoghurt, Ghee, Milk Powder, Cheese) rather than brand or
// Ravine's own category taxonomy. Confirmed by real field pricing data:
// the same brand routinely appears in multiple packaging types (e.g.
// "Mt Kenya ESL 500ml" AND "Mt Kenya Fino 500ml" as two separate lines),
// and the same packaging type appears across many different brands — so
// this is the dimension that actually enables a genuine cross-brand
// comparison ("Fino 500ml pricing across every brand"), which neither
// brand name nor Ravine's own 4-category grouping can do on its own.

const PACKAGING_TYPE_PATTERNS = [
  { type: "Fino", re: /\bfino\b/i },
  { type: "ESL", re: /\besl\b/i },
  { type: "UHT", re: /\buht\b/i },
  { type: "Lala Pouch", re: /\blala\b.*\bpouch\b|\bpouch\b.*\blala\b/i },
  { type: "Lala Bottle", re: /\blala\b.*\bbottle\b|\bbottle\b.*\blala\b/i },
  { type: "Yoghurt", re: /\byo?g?h?urt\b/i },
  { type: "Ghee", re: /\bghee\b/i },
  { type: "Milk Powder", re: /\bmilk\s*powder\b/i },
  { type: "Cheese", re: /\bcheese\b|\bcheddar\b/i },
];

/**
 * @param {string} text - any free text that might mention a packaging type
 *   (a competitor variant line, an "other category" note, etc).
 * @returns {string} the matched packaging type, or "Unspecified" if none found.
 */
function detectPackagingType(text) {
  if (!text) return "Unspecified";
  for (const { type, re } of PACKAGING_TYPE_PATTERNS) {
    if (re.test(text)) return type;
  }
  return "Unspecified";
}

module.exports = { detectPackagingType };
