/**
 * Insurance survey alert — email relay.
 *
 * The WhatsApp bot POSTs a small JSON message here whenever a PRULife survey
 * is completed, and this script emails it to the team. It uses Google's own
 * mail service, so there is no SMTP password to manage and nothing to install.
 *
 * ONE-TIME SETUP
 *  1. Go to script.google.com > New project. Paste this whole file in.
 *  2. Project Settings (gear icon) > Script properties > Add property:
 *       ALERT_SECRET = <a long random string; the same value goes in Render>
 *       ALLOWED_TO   = info@beamap.co.ke   (comma-separate to allow more)
 *  3. Deploy > New deployment > type "Web app":
 *       Execute as: Me
 *       Who has access: Anyone
 *     Click Deploy, authorise the mail permission when asked, and copy the
 *     Web app URL.
 *  4. In Render > Environment, set:
 *       ALERT_WEBHOOK_URL    = <that Web app URL>
 *       ALERT_WEBHOOK_SECRET = <the same ALERT_SECRET>
 *       ALERT_EMAIL_TO       = info@beamap.co.ke
 *
 * Notes
 *  - "Anyone" only means the URL can be called without a Google login; every
 *    call is rejected unless it carries the secret, and mail can only go to
 *    the addresses listed in ALLOWED_TO.
 *  - Mail is sent from the Google account that owns this script. Consumer
 *    Gmail allows roughly 100 recipients a day, plenty for survey alerts.
 *  - If you change this file later, use Deploy > Manage deployments > pencil
 *    (Edit) > Version: New version > Deploy. The URL stays the same; without a
 *    new version the live URL keeps running the old code.
 *  - The bot sends both a plain-text body and an HTML version; this script
 *    passes both to MailApp, which lets the mail program choose.
 */
function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty("ALERT_SECRET");
    var allowed = (props.getProperty("ALLOWED_TO") || "")
      .split(",")
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(Boolean);

    var data = JSON.parse(e.postData.contents);
    if (!secret || data.secret !== secret) return json_({ ok: false, error: "unauthorized" });

    var recipients = String(data.to || "")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    if (recipients.length === 0) return json_({ ok: false, error: "no recipient" });
    for (var i = 0; i < recipients.length; i++) {
      if (allowed.indexOf(recipients[i].toLowerCase()) === -1) {
        return json_({ ok: false, error: "recipient not allowed: " + recipients[i] });
      }
    }

    var mail = {
      to: recipients.join(","),
      subject: String(data.subject || "PRULife survey alert").slice(0, 200),
      body: String(data.body || ""), // plain-text version, shown by mail programs that can't display HTML
      name: "PRULife Survey Bot",
    };
    // Formatted version. Optional: if the bot doesn't send one (older bot
    // code) the email simply goes out as plain text, as before.
    if (typeof data.html === "string" && data.html.length > 0 && data.html.length < 200000) {
      mail.htmlBody = data.html;
    }
    MailApp.sendEmail(mail);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
