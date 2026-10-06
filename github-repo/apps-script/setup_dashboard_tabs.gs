/**
 * Creates (or recreates) the 4 dashboard tabs and populates them with the
 * formulas that reference the named ranges from setup_named_ranges.gs.
 *
 * Run setupNamedRanges() FIRST (from setup_named_ranges.gs) — these formulas
 * depend on those named ranges existing.
 *
 * Run this from Extensions > Apps Script > select setupDashboardTabs > Run.
 * Safe to re-run: it clears and rewrites each tab's content each time
 * (labels + formulas only — any manual formatting you add will be kept
 * since only columns A:B are touched).
 */
function setupDashboardTabs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const sections = [
    {
      name: 'Dashboard - Merchandising',
      rows: [
        ['Valid Visits', '=COUNTA(ReferenceNumber)'],
        ['Ravine Stocked %', '=COUNTIF(RavineStocked,"Yes")/B1'],
        ['Avg Shelf Visibility', '=AVERAGE(ShelfVisibilityRating)'],
        ['Full Planogram %', '=COUNTIF(PlanogramCompliance,"Yes")/COUNTA(PlanogramCompliance)'],
        ['POS Presence %', '=COUNTIFS(PosMaterialsPresent,"<>",PosMaterialsPresent,"<>None")/COUNTA(PosMaterialsPresent)'],
        ['Out of Stock %', buildOosFormula()],
        ['Avg Facings', buildAvgFacingsFormula()],
      ],
    },
    {
      name: 'Dashboard - Pricing',
      rows: [
        ['Ravine Avg Retail Price', buildRavineAvgRetailFormula()],
        ['Named-Brand Avg Price', '=AVERAGE(Reg_Brookside,Reg_Fresha,Reg_KCC,Reg_Tuzo,Reg_Ilara,Reg_Delamere,Reg_Daima)'],
        ['Ravine Price Index', '=B1/B2'],
        ['Promo Observations', '=COUNT(Promo_Brookside)+COUNT(Promo_Fresha)+COUNT(Promo_KCC)+COUNT(Promo_Tuzo)+COUNT(Promo_Ilara)+COUNT(Promo_Delamere)+COUNT(Promo_Daima)'],
      ],
    },
    {
      name: 'Dashboard - Collections',
      rows: [
        ['Total Collected (all visits)', '=SUM(CollectionAmount)'],
        ['Total Statement Debt', '=SUM(Stmt_Balance)'],
        ['Total Outstanding (latest/store, field)', '=SUMPRODUCT((StoreId<>"")*(COUNTIFS(StoreId,StoreId,SubmittedAt,">"&SubmittedAt)=0)*OutstandingBalance)'],
        ['Accounts Current (latest/store)', '=SUMPRODUCT((StoreId<>"")*(COUNTIFS(StoreId,StoreId,SubmittedAt,">"&SubmittedAt)=0)*(PaymentStatus="Current / Up to Date"))'],
        ['Accounts Overdue 14+ days', '=SUMPRODUCT((StoreId<>"")*(COUNTIFS(StoreId,StoreId,SubmittedAt,">"&SubmittedAt)=0)*(PaymentStatus="Overdue (14+ days)"))'],
      ],
    },
    {
      name: 'Dashboard - Availability',
      rows: [
        ['Ravine Stocked %', '=COUNTIF(RavineStocked,"Yes")/COUNTA(ReferenceNumber)'],
        ['Any Competitor Present %', '=COUNTIF(CompetitorBrandsRanked,"?*")/COUNTA(ReferenceNumber)'],
        ['Avg Competitor Brands / Visit', '=AVERAGE(ARRAYFORMULA(IF(CompetitorBrandsRanked="",0,LEN(CompetitorBrandsRanked)-LEN(SUBSTITUTE(CompetitorBrandsRanked,",",""))+1)))'],
      ],
    },
  ];

  sections.forEach(function (section) {
    let sheet = ss.getSheetByName(section.name);
    if (!sheet) {
      sheet = ss.insertSheet(section.name);
    } else {
      sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2).clearContent();
    }
    sheet.getRange(1, 1, section.rows.length, 2).setValues(section.rows);
    sheet.getRange(1, 1, section.rows.length, 1).setFontWeight('bold');
    sheet.autoResizeColumn(1);
    sheet.autoResizeColumn(2);
  });

  SpreadsheetApp.getUi().alert('4 dashboard tabs created/updated: Merchandising, Pricing, Collections, Availability.');
}

// ---- Formula builders (kept separate so the long strings don't clutter the layout above) ----

function buildOosFormula() {
  const skus = getSkuRangeNames();
  const numerators = skus.map(function (s) { return 'COUNTIF(StockStatus_' + s + ',"Out of Stock")'; }).join('+');
  const denominators = skus.map(function (s) { return 'COUNTA(StockStatus_' + s + ')'; }).join('+');
  return '=(' + numerators + ')/(' + denominators + ')';
}

function buildAvgFacingsFormula() {
  const skus = getSkuRangeNames();
  const stacked = skus.map(function (s) { return 'Facings_' + s; }).join(';');
  return '=AVERAGE({' + stacked + '})';
}

function buildRavineAvgRetailFormula() {
  const skus = getSkuRangeNames();
  const stacked = skus.map(function (s) { return 'Retail_' + s; }).join(';');
  return '=AVERAGE({' + stacked + '})';
}

function getSkuRangeNames() {
  const skus = [
    'Fino 500ml', 'ESL 500ml', 'ESL 200ml',
    'Lala Pouch 500ml', 'Lala Pouch 200ml', 'Lala Bottle 500ml',
    'Natural Yoghurt 500ml', 'Natural Yoghurt 250ml', 'Natural Yoghurt 150ml', 'Natural Yoghurt 100ml',
    'Vanilla Yoghurt 500ml', 'Vanilla Yoghurt 250ml', 'Vanilla Yoghurt 150ml', 'Vanilla Yoghurt 100ml',
    'Strawberry Yoghurt 500ml', 'Strawberry Yoghurt 250ml', 'Strawberry Yoghurt 150ml', 'Strawberry Yoghurt 100ml',
    'Crate 20 Litres', 'Ghee 20kg', 'Cream (per kg)',
  ];
  return skus.map(function (s) {
    return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  });
}
