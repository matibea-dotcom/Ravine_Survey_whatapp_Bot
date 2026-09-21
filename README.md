# WhatsApp Retail Survey Bot

A Node.js/Express bot that guides field agents through store-visit surveys
over WhatsApp (Meta Cloud API), across four survey tracks (General Trade,
Modern Trade, Insurance — placeholder, and Warehouse/HQ). Registrations,
store history, and submissions are all stored in Google Sheets so data
survives Render redeploys (Render's free tier has no persistent disk).

## What's implemented

- **Registration** (one-time per WhatsApp number): full name, agent ID,
  region, company, and a survey track pick — see `src/surveys/index.js`
  for `REGISTRATION_STEPS`. Also recognizes Meta's newer BSUID identity
  (`user_id`) when a person's phone number is hidden, and reconciles it
  against an agent's existing phone-based registration once both have
  been seen together.
- **Per-track survey flow**: each track's questions live in its own file
  under `src/surveys/` (`gt.js`, `mt.js`, `insurance.js`, `warehouse.js`),
  resolved at runtime by `src/surveys/index.js`.
  - **GT**: SKU-level pricing loop (wholesale + RRP per SKU).
  - **MT**: the richest track — store identity, a New-Outlet/Revisit
    picker (search by name rather than ever showing a full store list),
    prior-visit prefill on revisits, category → SKU catalog selection
    with auto-filled wholesale/retail pricing per SKU, per-SKU
    facings/stock-status, ranked competitor brands with both a quick
    overall price and detailed per-category free-text pricing (parsed
    automatically into `CompetitorPriceDetail`), an "other dairy
    categories" free-text field (parsed into `OtherCategoryPriceDetail`
    for brands/products outside Ravine's own catalog), payment status,
    outstanding balance, collections, and short-expiry stock — all
    ordered to match how an actual visit unfolds (identity → shelf →
    talk to staff → business/payments → wrap-up).
  - **Warehouse/HQ**: a meeting-notes style track for HQ/warehouse
    discussions — payments & outstanding dues, branch stock levels, and
    short expiries.
- **Stores registry** (MT only): a `Stores` tab so a store's identity only
  needs typing once; later visits search by name and confirm-or-edit a
  prior visit's answers instead of starting blank.
- **One-hot presence columns** (MT): every fixed-vocabulary multiselect
  field (categories stocked, SKUs stocked, ranked competitor brands, POS
  materials) also gets a `1`/`0` column per possible value, grouped as one
  contiguous block per SKU/brand, so pivot tables and `COUNTIF`/`SUMIF`
  work directly without parsing comma-joined text.
- **Global commands**: HELP, BACK, MENU, SAVE, RESUME, CANCEL, STATUS,
  RESTART, EXIT, SUMMARY, STOP, RESETAGENT, EDIT (edits an already-answered
  field; editing SKUs-stocked or ranked competitor brands correctly
  re-runs their pricing sub-loops for the new selection, not just the
  raw list)
- **Track commands**: MYTRACK, SWITCHTRACK
- **Admin commands** (restricted to `ADMIN_WA_IDS`):
  - `REPORT` — merchandising KPIs (stocked %, OOS %, facings, planogram, POS)
  - `PRICING` — Ravine vs named-brand price index, overall and by category
  - `COLLECTIONS` — total collected, outstanding balance, aging, accounts
    missing a written commitment
  - `RECONCILE` — cross-references the `Statements` tab (real order-system
    debt) against what agents report in the field, surfacing status
    mismatches, balance discrepancies, and stores with real debt but no
    MT visit yet
  - `TOPBRANDS` — real mention frequency for the fixed competitor-brand
    list plus brands outside it, to inform periodic manual review of
    `COMPETITOR_BRANDS` in `mt.js`
  - `SETTRACK <phone> <track>`, `RESETAGENTS` (two-step confirm)
- **Validation**: text/phone/numeric/select/multi-select/location/photo,
  with wholesale-vs-RRP cross-checks and rejection of non-text messages on
  text-based questions
- **Session management**: 30-min timeout (25-min warning), 24h resume
  window, auto-save, BACK/retry limits
- **Guardrails**: off-topic redirect + 3-strike pause, basic
  offensive-word screen, rate limiting + flood pause, duplicate-submission
  detection, quality flags logged silently to the sheet
- **Google Sheets storage**: `Agents`, `Stores`, one Submissions tab per
  track (GT → `Submissions`, MT → `MT_Submissions`, Insurance →
  `Insurance_Submissions`, Warehouse → `Warehouse_Submissions`), plus
  `Statements` (imported order-system debt), `CompetitorPriceDetail` and
  `OtherCategoryPriceDetail` (long-format, parsed from MT's free-text
  pricing fields — built for pivoting, not fixed columns). Both detail
  tabs classify each parsed line by **packaging type** (ESL, Fino, UHT,
  Lala Pouch/Bottle, Yoghurt, Ghee, Milk Powder, Cheese — see
  `src/packagingType.js`), since the same packaging type spans many
  brands and is often more useful to compare across brands than Ravine's
  own 4-category grouping alone. `CompetitorPriceDetail` also recognizes
  a SKU explicitly marked unavailable (`"N/A"`, an em dash, "out of
  stock", etc.) as a real "Out of Stock" signal rather than silently
  dropping it or treating it as a parsing failure, and carries a blank
  `stockoutReason` column meant for **manual tagging during review** —
  the bot deliberately never guesses or auto-fills a cause (e.g. supply
  disruption, logistics, demand), since that context isn't reliably in
  the raw text and would go stale if hardcoded. All tabs self-extend
  their header if new fields are added later. A `submittedAtDate`
  companion column (alongside the original ISO timestamp, untouched) is
  written in a format Sheets actually recognizes as a real date, so
  pivot tables can group by week/month/quarter.
- **Sheets API efficiency**: tab-existence checks are cached in-memory
  after the first lookup per tab, instead of re-checking on every write.

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
   companyName, surveyTrack, registeredAt, bsuid` (the code will add any
   missing columns automatically, but it's cleaner to have them from the
   start).
5. Every other tab (`Stores`, each track's Submissions tab, `Statements`,
   `CompetitorPriceDetail`, `OtherCategoryPriceDetail`) gets created and
   its header written automatically on first use — no manual setup needed.

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

## Optional: Google Sheets dashboards and KPI history

The `apps-script/` folder (separate from `src/` — these run inside Google
Sheets' own Apps Script editor, not as part of this Node app) contains
scripts to:
- `setup_named_ranges.gs` — create named ranges for every column the
  dashboards reference, read from the live header row rather than
  hardcoded letters
- `setup_dashboard_tabs.gs` — create 4 dashboard tabs (Merchandising,
  Pricing, Collections, Availability) with formulas wired to those
  named ranges
- `setup_kpi_tracker.gs` — snapshot the dashboard values into a
  permanent, timestamped `KPI Tracker` tab, with an optional weekly
  automatic trigger

Run `setupNamedRanges` first, then `setupDashboardTabs`, then (optionally)
`createKpiTrackerTab` + `setupWeeklyTrigger` from the KPI tracker script.

## Adding a new survey track

1. Create `src/surveys/<key>.js` matching the shape of `gt.js`/`mt.js`/
   `warehouse.js` (export `label`, `sheetTabEnvVar`, `defaultSheetTab`,
   `SURVEY_STEPS`, `COLUMNS`).
2. Register it in `src/surveys/index.js`: add it to the `TRACKS` object and
   `TRACK_ORDER` array.
3. That's it — registration, routing, and Sheets storage all pick it up
   automatically.

## Project structure

```
src/
  server.js                   Express app, webhook verification, rate limiting,
                               BSUID/phone identifier fallback
  engine.js                   Conversation state machine: commands, flow, flags,
                               SKU/competitor pricing loops, admin report commands
  competitorPriceParser.js    Parses free-text per-category competitor pricing
  otherCategoryPriceParser.js Parses free-text "other dairy categories" pricing
  packagingType.js            Classifies text by packaging type (ESL/Fino/UHT/etc.),
                               shared by both price parsers
  survey.js                   DEPRECATED shim — kept for backward compatibility only
  surveys/
    index.js         Track registry + shared REGISTRATION_STEPS
    gt.js             General Trade survey questions
    mt.js             Modern Trade survey questions (the primary track)
    insurance.js       Placeholder — real questions to follow
    warehouse.js       Warehouse/HQ meeting-notes track
  validators.js       Per-field input validation
  whatsapp.js          Send/mark-read helpers for the Cloud API
  sheets.js            Google Sheets read/write for every tab, plus all
                       admin-report computations (REPORT/PRICING/COLLECTIONS/
                       RECONCILE/TOPBRANDS)
  sessionStore.js      In-memory session state (timeouts, resume)
  agentStore.js        Sheets-backed agent registry, in-memory cache,
                       BSUID/phone cross-identifier lookup

apps-script/           Google Sheets-only scripts (NOT part of the Node app —
                        paste into Extensions > Apps Script in the Sheet itself)
  setup_named_ranges.gs
  setup_dashboard_tabs.gs
  setup_kpi_tracker.gs
```
