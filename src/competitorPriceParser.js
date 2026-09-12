// Parses the free-text "Variant – Regular Price – Promo Price" lines an
// agent enters for one competitor brand's products in one category (see
// mt.js's competitor loop). Unlike the historical-data importer's parser,
// this does NOT need to extract a brand name — the brand and category are
// already known from which question was asked, so each line only needs
// variant + regular + promo pulled out.

const NUM = "(\\d+(?:\\.\\d+)?)";

// Tried in order; first match wins. Named capture group "variant" plus
// positional numeric groups (index within THIS pattern's match).
// Checked FIRST: lines that are pure numbers with no variant text at all
// (e.g. an agent just types "65-60" instead of "500ml - 65 - 60"). Without
// these, a variant-capturing pattern below would wrongly swallow the first
// number as if it were a product name.
const BARE_PATTERNS = [
  { re: new RegExp(`^\\s*${NUM}\\s*-\\s*${NUM}\\s*$`), regIdx: 1, promoIdx: 2 }, // 65-60
  { re: new RegExp(`^\\s*${NUM}\\s*/\\s*${NUM}\\s*$`), regIdx: 1, promoIdx: 2 }, // 65/60
  { re: new RegExp(`^\\s*${NUM}\\s*/-\\s*$`), regIdx: 1, promoIdx: null },        // 65/-
  { re: new RegExp(`^\\s*${NUM}\\s*$`), regIdx: 1, promoIdx: null },              // 65

];

const LINE_PATTERNS = [
  { re: new RegExp(`^(?<variant>.+?)\\s*-\\s*${NUM}\\s*-\\s*${NUM}\\s*$`, "i"), regIdx: 2, promoIdx: 3 }, // Variant - 65 - 60
  { re: new RegExp(`^(?<variant>.+?)\\s*-\\s*${NUM}\\s*/\\s*${NUM}\\s*$`, "i"), regIdx: 2, promoIdx: 3 }, // Variant - 65/60
  { re: new RegExp(`^(?<variant>.+?)\\s*@\\s*ksh\\.?\\s*${NUM}`, "i"), regIdx: 2, promoIdx: null },        // Variant @ ksh 65
  { re: new RegExp(`^(?<variant>.+?)\\s*-\\s*${NUM}\\s*/-`, "i"), regIdx: 2, promoIdx: null },              // Variant - 65/-
  { re: new RegExp(`^(?<variant>.+?)\\s+${NUM}\\s*/-`, "i"), regIdx: 2, promoIdx: null },                   // Variant 65/- (no dash)
  { re: new RegExp(`^(?<variant>.+?)\\s*-\\s*${NUM}\\s*$`, "i"), regIdx: 2, promoIdx: null },               // Variant - 65
  { re: new RegExp(`^(?<variant>.+?)\\s+${NUM}\\s*$`, "i"), regIdx: 2, promoIdx: null },                    // Variant 65 (bare)
];

const BLANK_WORDS = new Set(["", "none", "n/a", "na", "null", "0", "skip"]);

function isBlankLine(line) {
  const t = line.trim().toLowerCase().replace(/\.$/, "");
  if (BLANK_WORDS.has(t)) return true;
  if (/out of stock|stock out|stocked out/.test(t)) return true;
  return false;
}

function cleanVariant(raw) {
  return raw.trim().replace(/[-:\s]+$/, "").replace(/^[-:\s]+/, "");
}

/**
 * @param {string} rawText - the agent's free-text answer for one brand+category.
 * @returns {Array<{variant: string, regular: number|null, promo: number|null, raw: string, parsed: boolean}>}
 */
function parseCompetitorPriceText(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  const lines = rawText
    .split(/[\n,]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const results = [];
  for (const line of lines) {
    if (isBlankLine(line)) continue;
    let matched = false;

    for (const { re, regIdx, promoIdx } of BARE_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const regular = regIdx != null ? parseFloat(m[regIdx]) : null;
      const promo = promoIdx != null ? parseFloat(m[promoIdx]) : null;
      results.push({ variant: "(unspecified)", regular, promo, raw: line, parsed: true });
      matched = true;
      break;
    }
    if (matched) continue;

    for (const { re, regIdx, promoIdx } of LINE_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const variant = cleanVariant(m.groups.variant || "") || "(unspecified)";
      const regular = regIdx != null ? parseFloat(m[regIdx]) : null;
      const promo = promoIdx != null ? parseFloat(m[promoIdx]) : null;
      results.push({ variant, regular, promo, raw: line, parsed: true });
      matched = true;
      break;
    }
    if (!matched) {
      // Couldn't confidently parse a price — keep the raw line so nothing
      // is silently dropped, flagged as unparsed for review.
      results.push({ variant: line, regular: null, promo: null, raw: line, parsed: false });
    }
  }
  return results;
}

module.exports = { parseCompetitorPriceText };
