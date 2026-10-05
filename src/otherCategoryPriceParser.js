// Parses the free-text "otherDairyCategoriesNote" answer (any dairy
// category outside Ravine's own catalog — e.g. milk powder — where agents
// have been recording detailed multi-brand, multi-size pricing in one
// comments field). Different shape from competitorPriceParser.js: here
// EACH LINE is its own brand, with several size/price pairs packed into
// that same line, e.g.:
//   Milk powder
//   Brookside 250g - 332/-,,, 400g 502/-,,, 900g 1055/-
//   Miksi 250g 549/-,,, 400g 630/-
// The first line (no prices in it) is taken as the product category name.

const { detectPackagingType } = require("./packagingType");

const SIZE_PRICE_PAIR = /(\d+(?:\.\d+)?\s?(?:g|kg|ml|l))\s*-?\s*(\d+(?:\.\d+)?)\s*\/?-?/gi;

function looksLikeCategoryHeader(line) {
  // A header line has no digit-led price pattern in it at all.
  return !/\d/.test(line);
}

function cleanBrand(raw) {
  return raw.trim().replace(/[-:\s]+$/, "");
}

/**
 * @param {string} rawText - the full otherDairyCategoriesNote answer.
 * @returns {Array<{category: string, brand: string, size: string, price: number, raw: string}>}
 */
function parseOtherCategoryPricing(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const results = [];
  let currentCategory = "Unspecified";

  for (const line of lines) {
    if (looksLikeCategoryHeader(line)) {
      currentCategory = line;
      continue;
    }

    // Everything before the first size/price match is the brand name.
    SIZE_PRICE_PAIR.lastIndex = 0;
    const firstMatch = SIZE_PRICE_PAIR.exec(line);
    if (!firstMatch) {
      // No parseable pricing on this line at all — keep it visible rather
      // than silently dropping it.
      results.push({ category: currentCategory, brand: cleanBrand(line), size: "", price: null, raw: line, packagingType: detectPackagingType(currentCategory) });
      continue;
    }
    const brand = cleanBrand(line.slice(0, firstMatch.index)) || "(unspecified)";

    SIZE_PRICE_PAIR.lastIndex = 0;
    let m;
    let foundAny = false;
    while ((m = SIZE_PRICE_PAIR.exec(line)) !== null) {
      foundAny = true;
      results.push({
        category: currentCategory,
        brand,
        size: m[1].replace(/\s+/g, ""),
        price: parseFloat(m[2]),
        raw: line,
        packagingType: detectPackagingType(currentCategory),
      });
    }
    if (!foundAny) {
      results.push({ category: currentCategory, brand, size: "", price: null, raw: line, packagingType: detectPackagingType(currentCategory) });
    }
  }

  return results;
}

module.exports = { parseOtherCategoryPricing };
