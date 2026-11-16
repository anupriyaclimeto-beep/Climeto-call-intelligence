# Climeto Call Intelligence

Local-first working cockpit for Calls, WhatsApp, Email, Campaigns, and Lead 360.

Zoho CRM remains the final CRM destination, but day-to-day visibility and actioning starts here.

## What is built

- `frontend/`: Vite + React workspace UI
- `backend/`: Express API with local SQLite (`sql.js`) data
- `backend/data/workspace.db`: local persisted database
- `docs/`: implementation notes and local API reference
- `scripts/`: local webhook test helpers

## Current phase

Calls-first MVP + **Manyreach live Campaigns feed**:

1. Dashboard with recent calls and platform feed
2. Calls list with search and stage filtering
3. Call detail route with summary, promise, next action, transcript, and score card
4. Lead 360 list and detail page
5. WhatsApp / Email skeleton tabs; Campaigns page polls live Manyreach events
6. Zoho navigation boundary in Settings and detail pages
7. Manyreach webhook receiver → `campaign_events` → Campaigns Platform Feed

## Local run

Backend:

```bash
cd backend
npm install
copy .env.example .env
# set MANYREACH_WEBHOOK_SECRET to a long random string
npm run start
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open:

- UI: `http://localhost:5173`
- API health: `http://localhost:4200/api/health`

### Database / migrations

On every backend boot:

1. Core tables are ensured with `CREATE TABLE IF NOT EXISTS`
2. Versioned migration `001_campaign_events` creates `webhook_events` + `campaign_events` (+ indexes)
3. Existing `activities` rows with `platform='campaign'` are copied into `campaign_events` with `is_seeded=1` (`INSERT OR IGNORE` — no deletes)

No manual migration command needed. Just restart the backend.

Env knobs (see `backend/.env.example`):

- `MANYREACH_WEBHOOK_SECRET` — required for webhook auth (`?token=`)
- `MANYREACH_API_KEY` — reserved for optional fallback sync (default off)
- `SHOW_SEEDED_CAMPAIGNS` — `false` hides seeded rows from `/api/campaigns/feed`

## Manyreach webhook setup

Localhost is not reachable from Manyreach servers. Expose your local API with a tunnel:

### Option A: cloudflared

```bash
cloudflared tunnel --url http://localhost:4200
```

### Option B: ngrok

```bash
ngrok http 4200
```

Then in Manyreach:

1. **Integrations → CustomWebhook → Connect**
2. Select events (sent / open / click / reply / bounce)
3. Paste URL:

```text
https://<public-url>/api/webhooks/manyreach?token=<MANYREACH_WEBHOOK_SECRET>
```

Example:

```text
https://abc123.trycloudflare.com/api/webhooks/manyreach?token=my-long-secret
```

### Debug raw payloads (for field mapping)

Real Manyreach payload shapes vary. Inspect the latest stored raw JSON:

```text
GET /api/webhooks/manyreach/debug?token=<MANYREACH_WEBHOOK_SECRET>&limit=10
```

Mapper lives in one place: `backend/src/services/manyreachMapper.js` (`normalizeManyreachEvent`).

## Local webhook testing

With backend running and `MANYREACH_WEBHOOK_SECRET` set:

```bash
# Python helper (reply/click/open/bounce/sent)
set MANYREACH_WEBHOOK_SECRET=dev-secret
python scripts/send_test_manyreach_event.py --all
```

Or see `scripts/send_test_manyreach_event.curl.md` for curl examples.

Then open **Campaigns** in the UI — feed auto-refreshes every 15 seconds.

## Backend tests

```bash
cd backend
npm test
```

Covers: valid token, bad token, duplicate event, unmatched lead, malformed JSON, feed visibility, debug endpoint.

## Notes

- Local mode still ships seeded November sample data for Calls / Lead 360.
- Live systems (Zoho, WhatsApp, etc.) are not touched by Manyreach work.
- Optional Manyreach API fallback sync is a skeleton only (`MANYREACH_SYNC_ENABLED=false`).
