# WhatsApp Retail Survey Bot

A Node.js/Express bot that guides field agents through a store-visit survey
over WhatsApp (Meta Cloud API) and writes each completed submission as a row
in a Google Sheet. Implements the flow, commands, validation, session
handling, and guardrails from the SOW/Guardrails spec.

## What's implemented

- **Registration** (one-time): full name, agent ID, region, company (`src/survey.js`)
- **Full survey flow**: retailer/contact/GPS, Product X pricing, competitor
  categories/products/pricing (with conditional branching), merchandising,
  distributor info, sold-in status, delivery days, comments
- **Global commands**: HELP, BACK, MENU, SAVE, RESUME, CANCEL, STATUS,
  RESTART, EXIT, SUMMARY, STOP
- **Survey commands**: START, SKIP, EDIT, SUBMIT, CONFIRM
- **Validation**: text/phone/numeric/select/multi-select/location, with
  wholesale-vs-RRP cross-checks
- **Session management**: 30-min timeout (25-min warning), 24h resume window,
  auto-save, BACK/retry limits
- **Guardrails**: off-topic redirect + 3-strike pause, basic offensive-word
  screen, rate limiting (30 msgs/min) + flood pause, duplicate-submission
  detection (same store/agent within 4h), quality flags (test values, sub-2-min
  completions, price anomalies) logged silently to the sheet
- **Google Sheets storage**: one row per submission, auto-created header

Admin commands (REPORT/MYDATA/STATS) are stubbed — wire them to a Sheets
query once you see real data volume.

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

1. Create a new Google Sheet. Copy the ID from its URL
   (`.../spreadsheets/d/<THIS_PART>/edit`) into `GOOGLE_SHEET_ID`.
2. In [Google Cloud Console](https://console.cloud.google.com): create a
   project → enable the **Google Sheets API** → create a **Service Account**
   → create a JSON key for it → save it as `service-account.json` in this
   project's root (or point `GOOGLE_SERVICE_ACCOUNT_FILE` elsewhere).
3. Open the Sheet, click Share, and share it with the service account's
   email (found in the JSON key, `client_email` field) as **Editor**.
4. The bot creates the header row automatically on first submission — no
   manual setup needed inside the sheet.

## 3. Configure and run

```bash
npm install
cp .env.example .env
# edit .env with your WhatsApp + Google Sheets values
npm start
```

The server listens on `PORT` (default 3000) and exposes:
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

The in-memory session/agent stores (`src/sessionStore.js`,
`src/agentStore.js`) are fine for a single instance. If you scale to multiple
instances or want state to survive restarts cleanly, swap them for Redis or
a small database table — the rest of the code doesn't need to change since
they're isolated modules.

## Customizing the survey

Everything about *what* is asked lives in `src/survey.js`:
- `PRODUCT_X_NAME`, `COMPETITOR_CATEGORIES`,
  `COMPETITOR_PRODUCTS_BY_CATEGORY`, `MERCHANDISING_DISPLAY_TYPES`,
  `SOLD_IN_STATUS_OPTIONS`, `DELIVERY_DAYS` — edit these lists directly.
- `SURVEY_STEPS` — add/remove/reorder questions, adjust `required`,
  `skipIf` (conditional branching), and `crossValidate` (e.g. RRP ≥
  wholesale) per field.

Sheet columns are defined in `src/sheets.js` (`COLUMNS`) — keep this in sync
if you add/remove survey fields.

## Project structure

```
src/
  server.js        Express app, webhook verification, rate limiting
  engine.js         Conversation state machine: commands, flow, flags
  survey.js          Question definitions and option lists
  validators.js      Per-field input validation
  whatsapp.js         Send/mark-read helpers for the Cloud API
  sheets.js            Google Sheets append logic
  sessionStore.js       In-memory session state (timeouts, resume)
  agentStore.js          File-backed agent registry
```
