# Workspace API Notes

## Local endpoints

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/calls`
- `GET /api/calls/:id`
- `GET /api/leads`
- `GET /api/leads/:id`
- `GET /api/activities`
- `GET /api/settings/zoho`

## Current design

- Calls are stored separately for calls-first UX.
- Lead detail also exposes a merged `timeline` that combines call and non-call activities.
- Zoho is treated as a navigation boundary first.

## Seeded local data

- November sample calls
- Lead records with owner, hotness, stage, and next action
- WhatsApp, Email, and Campaign activities
