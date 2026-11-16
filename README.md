# Climeto Call Intelligence

Local-first working cockpit for Calls, WhatsApp, Email, Campaigns, and Lead 360.

Zoho CRM remains the final CRM destination, but day-to-day visibility and actioning starts here.

## What is built

- `frontend/`: Vite + React workspace UI
- `backend/`: Express API with local seeded data
- `backend/data/workspace.db`: local persisted SQLite-compatible database powered by `sql.js`
- `docs/`: implementation notes and local API reference

## Current phase

Calls-first MVP is ready locally:

1. Dashboard with recent calls and platform feed
2. Calls list with search and stage filtering
3. Call detail route with summary, promise, next action, transcript, and score card
4. Lead 360 list and detail page
5. WhatsApp, Email, and Campaign skeleton tabs
6. Zoho navigation boundary in Settings and detail pages

## Local run

Backend:

```bash
cd backend
npm install
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

## Notes

- Local mode uses seeded November sample data.
- Live systems are not touched by this repo.
- Zoho auth is not required for phase 1.
