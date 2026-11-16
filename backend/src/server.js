import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDb } from './db.js';
import { createApp } from './createApp.js';
import { syncManyreachEvents } from './jobs/manyreachSyncSkeleton.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded whether run from repo root or backend/
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env') });

await initializeDb();

const app = createApp();
const port = Number(process.env.PORT || 4200);

app.listen(port, () => {
  console.log(`Workspace API running on http://localhost:${port}`);

  const syncEnabled = String(process.env.MANYREACH_SYNC_ENABLED || 'false').toLowerCase() === 'true';
  const apiKey = process.env.MANYREACH_API_KEY || '';

  if (syncEnabled && apiKey) {
    const intervalSec = Math.max(Number(process.env.MANYREACH_SYNC_INTERVAL_SEC || 60), 15);
    console.log(`[Manyreach] Auto-sync enabled. Polling every ${intervalSec}s.`);

    // Initial sync
    syncManyreachEvents()
      .then((res) => console.log('[Manyreach] Initial sync complete:', res))
      .catch((err) => console.warn('[Manyreach] Initial sync error:', err.message));

    // Periodic sync
    setInterval(() => {
      syncManyreachEvents()
        .then((res) => {
          if (res?.inserted > 0) {
            console.log(`[Manyreach] Synced ${res.inserted} new event(s).`);
          }
        })
        .catch((err) => console.warn('[Manyreach] Periodic sync error:', err.message));
    }, intervalSec * 1000);
  }
});

export { app };
