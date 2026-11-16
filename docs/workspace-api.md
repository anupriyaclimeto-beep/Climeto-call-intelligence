# Workspace API Notes

## Local endpoints

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/calls`
- `GET /api/calls/:id`
- `GET /api/leads`
- `GET /api/leads/:id`
- `GET /api/activities`
- `GET /api/campaigns/feed?limit=50&since=<iso-timestamp>`
- `POST /api/webhooks/manyreach?token=<MANYREACH_WEBHOOK_SECRET>`
- `GET /api/webhooks/manyreach/debug?token=<MANYREACH_WEBHOOK_SECRET>&limit=10`
- `GET /api/settings/zoho`

## Campaigns / Manyreach

- Raw webhook bodies land in `webhook_events` first, then are normalized into `campaign_events`.
- Feed returns `lead_name`, `phone`, `email`, `campaign_name`, `event_type`, `title`, `description`, `occurred_at`.
- `SHOW_SEEDED_CAMPAIGNS=false` hides `is_seeded=1` rows.
- Debug endpoint exposes latest raw payload so mapper keys can be finalized safely.

## Current design

- Calls are stored separately for calls-first UX.
- Lead detail also exposes a merged `timeline` that combines call and non-call activities.
- Zoho is treated as a navigation boundary first.
- Live Zoho / WhatsApp connectors are not modified by Manyreach work.

## Seeded local data

- November sample calls
- Lead records with owner, hotness, stage, and next action
- WhatsApp, Email, and Campaign activities (campaign activities also backfilled into `campaign_events` as seeded)
