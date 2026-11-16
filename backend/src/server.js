import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDb, createCompletedCall } from './db.js';
import { createApp } from './createApp.js';
import { createSupabaseBridge } from './services/supabaseBridge.js';
import { syncManyreachEvents } from './jobs/manyreachSyncSkeleton.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded whether run from repo root or backend/
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env') });

await initializeDb();

const app = createApp();
const port = Number(process.env.PORT || 4200);

const eventClients = new Set();

function sendEvent(type, payload) {
  const message = `data: ${JSON.stringify({ type, payload, sentAt: new Date().toISOString() })}\n\n`;
  for (const client of eventClients) {
    client.write(message);
  }
}

const supabaseBridge = createSupabaseBridge({
  upsertCall(payload) {
    return createCompletedCall(payload);
  },
  notifyNewCall(call) {
    sendEvent('call.completed', {
      id: call.id,
      lead_id: call.lead_id,
      client_name: call.client_name,
      executive_name: call.executive_name,
      created_at: call.created_at,
    });
  },
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', sentAt: new Date().toISOString() })}\n\n`);
  eventClients.add(res);

  req.on('close', () => {
    eventClients.delete(res);
  });
});

app.post('/api/calls/complete', (req, res) => {
  const call = createCompletedCall(req.body || {});
  sendEvent('call.completed', {
    id: call.id,
    lead_id: call.lead_id,
    client_name: call.client_name,
    executive_name: call.executive_name,
    created_at: call.created_at,
  });
  return res.status(201).json({ success: true, data: call });
});

app.post('/api/dev/simulate-call', (_req, res) => {
  const stamp = Date.now();
  const suffix = String(stamp).slice(-4);
  const call = createCompletedCall({
    id: `sim-call-${suffix}`,
    clientName: `Realtime Prospect ${suffix}`,
    clientPhone: `+9199000${suffix}`,
    company: `Realtime Prospect ${suffix}`,
    executiveName: 'Ambuj Pathak',
    durationSeconds: 96,
    summary: 'Live test call inserted immediately after completion.',
    promise: 'Client asked for quotation on WhatsApp',
    nextAction: 'Send quotation and follow up in 30 minutes',
    transcript: 'Employee: Demo follow-up call complete.\\nClient: Quote bhej dijiye.',
    sentiment: 'Positive',
    direction: 'Outgoing',
  });

  sendEvent('call.completed', {
    id: call.id,
    lead_id: call.lead_id,
    client_name: call.client_name,
    executive_name: call.executive_name,
    created_at: call.created_at,
  });

  return res.status(201).json({ success: true, data: call });
});

await supabaseBridge.start();

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
