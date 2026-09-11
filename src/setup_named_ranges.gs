/**
 * One-time setup: creates named ranges for every column the dashboards need,
 * by looking up each column's position from the actual header row (row 1)
 * rather than hardcoded letters. Safe to re-run any time — it just
 * overwrites the same names with fresh positions if columns ever move.
 *
 * Run this from Extensions > Apps Script > select setupNamedRanges > Run.
 */
function setupNamedRanges() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mtSheet = ss.getSheetByName('MT_Submissions');
  const stmtSheet = ss.getSheetByName('Statements');

  if (!mtSheet) {
    SpreadsheetApp.getUi().alert('Could not find a tab named "MT_Submissions". Check the tab name and try again.');
    return;
  }

  const header = mtSheet.getRange(1, 1, 1, mtSheet.getLastColumn()).getValues()[0];
  const maxRows = mtSheet.getMaxRows(); // whole column, so it covers future rows too
  const notFound = [];

  function nameFor(label) {
    return label.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function setRange(rangeName, colName) {
    const colIndex = header.indexOf(colName);
    if (colIndex === -1) {
      notFound.push(rangeName + ' (looking for column "' + colName + '")');
      return;
    }
    const range = mtSheet.getRange(2, colIndex + 1, maxRows - 1, 1);
    ss.setNamedRange(rangeName, range);
  }

  // ---- Single-value fields ----
  const singleFields = {
    'ReferenceNumber': 'referenceNumber',
    'SubmittedAt': 'submittedAt',
    'StoreId': 'storeId',
    'RavineStocked': 'ravineStocked',
    'ShelfVisibilityRating': 'shelfVisibilityRating',
    'PlanogramCompliance': 'planogramCompliance',
    'PosMaterialsPresent': 'posMaterialsPresent',
    'PaymentStatus': 'paymentStatus',
    'OutstandingBalance': 'outstandingBalance',
    'CollectionAmount': 'collectionAmount',
    'CompetitorBrandsRanked': 'competitorBrandsRanked',
  };
  for (const rangeName in singleFields) {
    setRange(rangeName, singleFields[rangeName]);
  }

  // ---- Ravine catalog (must match src/surveys/mt.js RAVINE_SKU_LIST exactly) ----
  const skus = [
    'Fino 500ml', 'ESL 500ml', 'ESL 200ml',
    'Lala Pouch 500ml', 'Lala Pouch 200ml', 'Lala Bottle 500ml',
    'Natural Yoghurt 500ml', 'Natural Yoghurt 250ml', 'Natural Yoghurt 150ml', 'Natural Yoghurt 100ml',
    'Vanilla Yoghurt 500ml', 'Vanilla Yoghurt 250ml', 'Vanilla Yoghurt 150ml', 'Vanilla Yoghurt 100ml',
    'Strawberry Yoghurt 500ml', 'Strawberry Yoghurt 250ml', 'Strawberry Yoghurt 150ml', 'Strawberry Yoghurt 100ml',
    'Crate 20 Litres', 'Ghee 20kg', 'Cream (per kg)',
  ];
  skus.forEach(function (sku) {
    const n = nameFor(sku);
    setRange('Facings_' + n, sku + ' Facings');
    setRange('StockStatus_' + n, sku + ' Stock Status');
    setRange('WS_' + n, sku + ' (WS/Carton)');
    setRange('Retail_' + n, sku + ' (Retail/Piece)');
  });

  // ---- Competitor brands ----
  const brands = ['Brookside', 'Fresha', 'KCC', 'Tuzo', 'Ilara', 'Delamere', 'Daima'];
  brands.forEach(function (b) {
    setRange('Cat_' + b, b + ' Categories');
    setRange('Reg_' + b, b + ' Regular Price');
    setRange('Promo_' + b, b + ' Promo Price');
  });

  // ---- Statements tab ----
  if (stmtSheet) {
    const stmtHeader = stmtSheet.getRange(1, 1, 1, stmtSheet.getLastColumn()).getValues()[0];
    const stmtMaxRows = stmtSheet.getMaxRows();
    function setStmtRange(rangeName, colName) {
      const colIndex = stmtHeader.indexOf(colName);
      if (colIndex === -1) {
        notFound.push(rangeName + ' (Statements column "' + colName + '")');
        return;
      }
      const range = stmtSheet.getRange(2, colIndex + 1, stmtMaxRows - 1, 1);
      ss.setNamedRange(rangeName, range);
    }
    setStmtRange('Stmt_StoreId', 'storeId');
    setStmtRange('Stmt_Balance', 'balance');
    setStmtRange('Stmt_PaymentStatus', 'paymentStatus');
  } else {
    notFound.push('Statements tab not found — Stmt_* ranges skipped');
  }

  if (notFound.length > 0) {
    Logger.log('Could not create these ranges:\n' + notFound.join('\n'));
    SpreadsheetApp.getUi().alert(
      'Named ranges created, but ' + notFound.length + ' were skipped (columns not found). ' +
      'Check View > Executions or the Apps Script log for details.'
    );
  } else {
    SpreadsheetApp.getUi().alert('All named ranges created successfully.');
  }
}
