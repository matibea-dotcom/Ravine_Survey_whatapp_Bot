/**
 * Campaign Funnel - one-click summary of the PRULife survey, by channel.
 *
 * Builds a "Campaign Funnel" tab that counts, for each channel (WhatsApp
 * Status, Instagram, Facebook, TikTok, QR code, Direct, and any other tag):
 *   Started -> Agreed to consent -> Completed   (plus Declined / Not eligible)
 * and the two rates worth watching. It reads the "Insurance_Events" tab, which
 * the bot fills in automatically (no names or phone numbers are recorded there).
 *
 * HOW TO RUN (once)
 *  1. Open your survey Google Sheet > Extensions > Apps Script.
 *  2. Create a new file (+ > Script), paste this whole file in, and Save.
 *  3. Choose "setupCampaignFunnel" in the function drop-down and press Run.
 *     Approve the permissions the first time (it only edits this spreadsheet).
 *  4. A "Campaign Funnel" tab appears. It is made of formulas, so it updates
 *     by itself as new events arrive - you never need to run this again
 *     (running it again simply rebuilds the tab from scratch).
 */
function setupCampaignFunnel() {
  var EVENTS = "Insurance_Events";
  var FUNNEL = "Campaign Funnel";
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // The bot creates Insurance_Events itself on its first event; create it here
  // too (header only) so the formulas below never point at a missing tab.
  var ev = ss.getSheetByName(EVENTS);
  if (!ev) {
    ev = ss.insertSheet(EVENTS);
    ev.getRange(1, 1, 1, 5).setValues([["eventAt", "sessionId", "source", "event", "referenceNumber"]]);
    ev.setFrozenRows(1);
  }

  var sh = ss.getSheetByName(FUNNEL);
  if (sh) { sh.clear(); } else { sh = ss.insertSheet(FUNNEL); }

  var sources = ["WhatsApp Status", "Instagram", "Facebook", "TikTok", "QR code", "Direct"];
  var FIRST = 5;                       // first channel row
  var LAST = FIRST + sources.length - 1; // last named channel row
  var OTHER = LAST + 1;                // "Other tags" row
  var TOTAL = OTHER + 1;               // "All channels" row

  sh.getRange(1, 1).setValue("Campaign Funnel - PRULife survey").setFontWeight("bold").setFontSize(14);
  sh.getRange(2, 1).setValue("Counts come from the Insurance_Events tab and update automatically. No names or phone numbers are recorded there.");

  var header = ["Channel", "Started", "Agreed to consent", "Completed", "Declined", "Not eligible (age)", "Agreed -> completed", "Started -> completed"];
  sh.getRange(4, 1, 1, header.length).setValues([header])
    .setFontWeight("bold").setBackground("#E8192C").setFontColor("#FFFFFF").setWrap(true);

  var cols = { B: "STARTED", C: "CONSENTED", D: "SUBMITTED", E: "DECLINED", F: "INELIGIBLE" };
  function countFor(event, row) {
    return '=COUNTIFS(' + EVENTS + '!$D:$D,"' + event + '",' + EVENTS + '!$C:$C,$A' + row + ')';
  }
  function countAll(event) {
    return '=COUNTIF(' + EVENTS + '!$D:$D,"' + event + '")';
  }
  function rates(row) {
    return [
      '=IF(C' + row + '=0,"",D' + row + '/C' + row + ')',
      '=IF(B' + row + '=0,"",D' + row + '/B' + row + ')'
    ];
  }

  // Named channels
  for (var i = 0; i < sources.length; i++) {
    var r = FIRST + i;
    sh.getRange(r, 1).setValue(sources[i]);
    var f = [];
    for (var c in cols) { f.push(countFor(cols[c], r)); }
    f = f.concat(rates(r));
    sh.getRange(r, 2, 1, 7).setFormulas([f]);
  }

  // Any tag that is not one of the named channels (e.g. PRULIFE-FLYER2) = total minus the named rows
  sh.getRange(OTHER, 1).setValue("Other tags");
  var fo = [], k = 0;
  for (var c2 in cols) {
    var colLetter = String.fromCharCode(66 + k); // B..F
    fo.push(countAll(cols[c2]) + "-SUM(" + colLetter + FIRST + ":" + colLetter + LAST + ")");
    k++;
  }
  fo = fo.concat(rates(OTHER));
  sh.getRange(OTHER, 2, 1, 7).setFormulas([fo]);

  // Totals
  sh.getRange(TOTAL, 1).setValue("All channels");
  var ft = [];
  for (var c3 in cols) { ft.push(countAll(cols[c3])); }
  ft = ft.concat(rates(TOTAL));
  sh.getRange(TOTAL, 2, 1, 7).setFormulas([ft]);
  sh.getRange(TOTAL, 1, 1, 8).setFontWeight("bold").setBackground("#FBE9EB");

  sh.getRange(FIRST, 7, TOTAL - FIRST + 1, 2).setNumberFormat("0%");
  sh.getRange(FIRST, 2, TOTAL - FIRST + 1, 7).setHorizontalAlignment("center");

  var notes = [
    "How to read this",
    "Started = someone opened the chat and the bot began the survey. A person who taps the link twice is counted once.",
    "Agreed to consent = answered 'Yes, I agree'. Declined = answered No (nothing is saved about them).",
    "Completed = survey submitted. Not eligible = date of birth outside 18-60.",
    "Started -> completed is the number to compare between channels. Agreed -> completed shows how many who agreed went on to finish.",
    "Counts begin from the day the funnel update was deployed. Direct = no channel tag in the first message."
  ];
  for (var n = 0; n < notes.length; n++) { sh.getRange(TOTAL + 2 + n, 1).setValue(notes[n]); }
  sh.getRange(TOTAL + 2, 1).setFontWeight("bold");

  sh.setColumnWidth(1, 170);
  for (var w = 2; w <= 8; w++) { sh.setColumnWidth(w, 125); }
  sh.setFrozenRows(4);
  ss.setActiveSheet(sh);
}
