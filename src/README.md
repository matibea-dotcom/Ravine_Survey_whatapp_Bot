# WhatsApp Retail Survey Bot

A Node.js/Express bot that guides field agents through store-visit surveys
over WhatsApp (Meta Cloud API), with support for multiple survey tracks
(General Trade, Modern Trade, and Insurance — coming soon). Registrations and
submissions are stored in Google Sheets so data survives Render redeploys
(Render's free tier has no persistent disk).

## What's implemented

- **Registration** (one-time per WhatsApp number): full name, agent ID,
  region, company, and a survey track pick (GT/MT/Insurance) — see
  `src/surveys/index.js` for `REGISTRATION_STEPS`.
- **Per-track survey flow**: each track's questions live in its own file
  under `src/surveys/` (`gt.js`, `mt.js`, `insurance.js`), resolved at
  runtime by `src/surveys/index.js`. GT includes a SKU-level pricing loop
  (wholesale + RRP per SKU); MT covers stock status, Digital Path ordering
  status, collections, merchandising, and short-expiry stock.
- **Global commands**: HELP, BACK, MENU, SAVE, RESUME, CANCEL, STATUS,
  RESTART, EXIT, SUMMARY, STOP, RESETAGENT
- **Track commands**: MYTRACK (check your track), SWITCHTRACK (change your
  own track — clears any in-progress survey)
- **Admin commands** (restricted to `ADMIN_WA_IDS`): REPORT, MYDATA, STATS,
  SETTRACK `<phone> <track>` (fix any agent's track remotely),
  RESETAGENTS (two-step confirm — wipes ALL registered agents/sessions)
- **Validation**: text/phone/numeric/select/multi-select/location, with
  wholesale-vs-RRP cross-checks
- **Session management**: 30-min timeout (25-min warning), 24h resume window,
  auto-save, BACK/retry limits
- **Guardrails**: off-topic redirect + 3-strike pause, basic offensive-word
  screen, rate limiting (30 msgs/min) + flood pause, duplicate-submission
  detection (same store/account + agent within 4h), quality flags (test
  values, sub-2-min completions, price anomalies) logged silently to the sheet
- **Google Sheets storage**: one "Agents" tab for registrations (self-extends
  its header if you add new agent fields later), one Submissions tab per
  track — GT writes to "Submissions", MT to "MT_Submissions"

## 1. Create the Meta WhatsApp app

1. Go to [developers.facebook.com](https://developers.facebook.com) → create
   an app → add the **WhatsApp** product.
2. Under WhatsApp → API Setup, note your **Phone Number ID** and generate a
   **temporary access token** (swap for a permanent token via a System User
   before going live).
3. Under WhatsApp → Configuration, set the **Webhook URL** to
   `https://<your-deployed-host>/webhook` and the **Verify Token** to any
   string you choose — put the same string in `.env` as `WHATSAPP_VERIFY_TOKEN`.
4. Subscribe the webhook to the `messages` field.

## 2. Create the Google Sheet + service account

1. Create a new Google Sheet (or reuse your existing one). Copy the ID from
   its URL (`.../spreadsheets/d/<THIS_PART>/edit`) into `GOOGLE_SHEET_ID`.
2. In [Google Cloud Console](https://console.cloud.google.com): create a
   project → enable the **Google Sheets API** → create a **Service Account**
   → create a JSON key for it → save it as `service-account.json` in this
   project's root (or point `GOOGLE_SERVICE_ACCOUNT_FILE` elsewhere).
3. Open the Sheet, click Share, and share it with the service account's
   email (found in the JSON key, `client_email` field) as **Editor**.
4. Add an **"Agents"** tab with header row: `waId, fullName, agentId, region,
   companyName, surveyTrack, registeredAt` (the code will add `surveyTrack`
   automatically if it's missing, but it's cleaner to have it from the start).
5. The bot creates each Submissions tab's header row automatically on first
   submission — no manual setup needed there.

## 3. Configure and run

```bash
npm install
cp .env.example .env
# edit .env with your WhatsApp + Google Sheets values
npm start
```

The server listens on `PORT` (default 3000) and exposes:
- `GET /health` — health check for monitoring
- `GET /webhook` — Meta's verification handshake
- `POST /webhook` — inbound message handler

For local testing before you have a public host, tunnel it (e.g.
`ngrok http 3000`) and use the tunnel URL as the Meta webhook URL.

## 4. Deploy

Any Node host works (Render, Railway, Fly.io, a small VPS, etc.). Requirements:
- Node 18+
- `service-account.json` present (or mounted as a secret file)
- Environment variables from `.env.example` set
- A public HTTPS URL for the webhook

Sessions (`src/sessionStore.js`) are in-memory and fine for a single
instance. If you scale to multiple instances or want state to survive
restarts, swap it for Redis or a database table.

## Adding a new survey track

1. Create `src/surveys/<key>.js` matching the shape of `gt.js`/`mt.js`
   (export `label`, `sheetTabEnvVar`, `defaultSheetTab`, `SURVEY_STEPS`,
   `COLUMNS`).
2. Register it in `src/surveys/index.js`: add it to the `TRACKS` object and
   `TRACK_ORDER` array.
3. That's it — registration, routing, and Sheets storage all pick it up
   automatically.

## Project structure

```
src/
  server.js          Express app, webhook verification, rate limiting
  engine.js          Conversation state machine: commands, flow, flags
  survey.js          DEPRECATED shim — kept for backward compatibility only
  surveys/
    index.js         Track registry + shared REGISTRATION_STEPS
    gt.js            General Trade survey questions
    mt.js            Modern Trade survey questions
    insurance.js     Placeholder — real questions to follow
  validators.js      Per-field input validation
  whatsapp.js        Send/mark-read helpers for the Cloud API
  sheets.js          Google Sheets read/write (Agents + per-track Submissions)
  sessionStore.js    In-memory session state (timeouts, resume)
  agentStore.js      Sheets-backed agent registry with an in-memory cache
```
