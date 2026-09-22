/**
 * Builds a permanent week-on-week KPI history, separate from the live
 * dashboard tabs (which only ever show the CURRENT state).
 *
 * Reads from the "Dashboard Data" tab by LABEL TEXT, not fixed cell
 * positions — resilient to the dashboard layout changing again later, as
 * long as each label's value stays one column to its right (the existing
 * convention in that tab: Merchandising KPI/Value in A:B, Pricing KPI/Value
 * in D:E, Collections KPI/Value in G:H, Availability KPI/Value in J:K).
 *
 * Run createKpiTrackerTab() ONCE to set up the tab.
 * Run captureWeeklySnapshot() any time to log a snapshot immediately.
 * Run setupWeeklyTrigger() ONCE to make it capture automatically every
 * Monday morning — after that you never need to touch this again.
 */

var TRACKER_SHEET_NAME = 'KPI Tracker';
var DASHBOARD_DATA_TAB = 'Dashboard Data';

var KPI_DEFINITIONS = [
  ['Valid Visits', 'A', 'Valid Visits'],
  ['Ravine Stocked %', 'A', 'Ravine Stocked %'],
  ['Avg Shelf Visibility', 'A', 'Avg Shelf Visibility'],
  ['Full Planogram %', 'A', 'Full Planogram %'],
  ['POS Presence %', 'A', 'POS Presence %'],
  ['Eye-Level Placement %', 'A', 'Eye-Level Placement %'],
  ['Avg Facings', 'A', 'Avg Facings'],
  ['Ravine Avg Retail Price', 'D', 'Ravine Avg Retail Price'],
  ['Named-Brand Avg Price', 'D', 'Named-Brand Avg Price'],
  ['Ravine Price Index', 'D', 'Ravine Price Index'],
  ['Promo Observations', 'D', 'Promo Observations'],
  ['Cheaper or Same %', 'D', 'Cheaper or Same %'],
  ['Total Collected', 'G', 'Total Collected'],
  ['Coverage %', 'G', 'Coverage %'],
  ['Current Accounts', 'G', 'Current Accounts'],
  ['Overdue Accounts', 'G', 'Overdue Accounts'],
  ['Pending Order Flags', 'G', 'Pending Order Flags'],
  ['Competitor Presence %', 'J', 'Competitor Presence %'],
  ['Avg Ravine SKUs / Stocked Outlet', 'J', 'Avg Ravine SKUs / Stocked Outlet'],
  ['Not Stocked Outlets', 'J', 'Not Stocked Outlets'],
  ['Low Stock Signals', 'J', 'Low Stock Signals'],
  ['Stock Status Observations', 'J', 'Stock Status Observations'],
];

function columnLetterToIndex(letter) {
  return letter.toUpperCase().charCodeAt(0) - 65;
}

function createKpiTrackerTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TRACKER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TRACKER_SHEET_NAME);
  }
  var headers = ['Snapshot Date'].concat(KPI_DEFINITIONS.map(function (d) { return d[0]; }));
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  SpreadsheetApp.getUi().alert(
    'KPI Tracker tab created. Run captureWeeklySnapshot() to log the first row now, ' +
    'or setupWeeklyTrigger() to automate it going forward.'
  );
}

function readKpiByLabel(labelColumnLetter, labelText) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DASHBOARD_DATA_TAB);
  if (!sheet) return '(Dashboard Data tab not found)';

  var labelColIndex = columnLetterToIndex(labelColumnLetter);
  var data = sheet.getDataRange().getValues();
  for (var r = 0; r < data.length; r++) {
    if (data[r][labelColIndex] === labelText) {
      return data[r][labelColIndex + 1];
    }
  }
  return '(label not found: "' + labelText + '")';
}

function captureWeeklySnapshot() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var trackerSheet = ss.getSheetByName(TRACKER_SHEET_NAME);
  if (!trackerSheet) {
    createKpiTrackerTab();
    trackerSheet = ss.getSheetByName(TRACKER_SHEET_NAME);
  }

  var row = [new Date()];
  var missing = [];
  KPI_DEFINITIONS.forEach(function (def) {
    var value = readKpiByLabel(def[1], def[2]);
    if (typeof value === 'string' && value.indexOf('(label not found') === 0) {
      missing.push(def[0]);
    }
    row.push(value);
  });

  trackerSheet.appendRow(row);

  if (missing.length > 0) {
    Logger.log('Snapshot captured, but these labels were not found in Dashboard Data: ' + missing.join(', '));
  }
}

function setupWeeklyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'captureWeeklySnapshot') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('captureWeeklySnapshot')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();
  SpreadsheetApp.getUi().alert('Weekly snapshot scheduled: every Monday around 7am, automatically.');
}
