import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initializeDb,
  createCompletedCall,
  syncExecutiveDirectoryFromCalling,
  listCalls,
  getClientIntelByTarget,
} from './db.js';
import { createApp } from './createApp.js';
import { createSupabaseBridge } from './services/supabaseBridge.js';
import { syncManyreachEvents } from './jobs/manyreachSyncSkeleton.js';
import { autoResumeWhatsAppSessions } from './services/whatsappBridge.js';
import { syncZohoAccounts, syncZohoCrm } from './services/zohoSync.js';
import { syncZohoEmails } from './services/zohoEmailSync.js';
import {
  enqueueLiveCallEvaluation,
  setTrainingEventEmitter,
} from './services/pitchAnalyzer.js';
import { extractClientIntelForCall } from './services/clientIntelExtractor.js';
import { extractAndSaveCallAnalysis } from './services/callExtractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded whether run from repo root or backend/
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env') });

await initializeDb();

const eventClients = new Set();

function sendEvent(type, payload) {
  const message = `data: ${JSON.stringify({ type, payload, sentAt: new Date().toISOString() })}\n\n`;
  for (const client of eventClients) {
    client.write(message);
  }
}

setTrainingEventEmitter(sendEvent);

async function triggerCallIntelExtraction(call) {
  if (!call?.id) return;
  try {
    const intel = await extractClientIntelForCall(call.id);
    try {
      await extractAndSaveCallAnalysis({
        callId: call.id,
        transcript: call.transcript || call.summary || '',
        callDate: call.created_at,
        callerNumber: call.client_phone,
      });
    } catch (analysisErr) {
      console.warn(`[CallAnalysis] Auto-extraction notice for call ${call.id}:`, analysisErr.message);
    }
    sendEvent('client.intel_extracted', intel);
    sendEvent('client.intel_updated', intel);
    return intel;
  } catch (err) {
    console.warn(`[ClientIntel] Auto-extraction error for call ${call.id}:`, err.message);
    return null;
  }
}

const supabaseBridge = createSupabaseBridge({
  upsertCall(payload) {
    return createCompletedCall(payload);
  },
  syncCallingUsers(users) {
    return syncExecutiveDirectoryFromCalling(users);
  },
  notifyNewCall(call) {
    sendEvent('call.completed', {
      id: call.id,
      lead_id: call.lead_id,
      client_name: call.client_name,
      executive_name: call.executive_name,
      created_at: call.created_at,
    });
    enqueueLiveCallEvaluation(call.id);
    triggerCallIntelExtraction(call);
  },
});

const app = createApp({ sendEvent, supabaseBridge });
const port = Number(process.env.PORT || 4200);

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
  enqueueLiveCallEvaluation(call.id);
  triggerCallIntelExtraction(call);
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
  enqueueLiveCallEvaluation(call.id);
  triggerCallIntelExtraction(call);

  return res.status(201).json({ success: true, data: call });
});

await supabaseBridge.start();

app.listen(port, () => {
  console.log(`Workspace API running on http://localhost:${port}`);

  // Auto-backfill real client intel for existing calls sequentially
  (async () => {
    try {
      const allCalls = listCalls();
      for (const c of allCalls) {
        const existing = getClientIntelByTarget('call', c.id);
        if (!existing) {
          await triggerCallIntelExtraction(c);
        }
      }
    } catch (err) {
      console.warn('[ClientIntel] Initial call intel sync notice:', err.message);
    }
  })();

  // Auto-resume any authenticated WhatsApp Multi-Device sessions
  autoResumeWhatsAppSessions({ sendEvent }).catch((err) => {
    console.warn('[WhatsApp Bridge] Session resume notice:', err.message);
  });

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

  const zohoSyncEnabled = String(process.env.ZOHO_SYNC_ENABLED || 'true').toLowerCase() === 'true';
  const zohoHasAuth = Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_REFRESH_TOKEN);

  if (zohoSyncEnabled && zohoHasAuth) {
    const zohoIntervalSec = Math.max(Number(process.env.ZOHO_SYNC_INTERVAL_SEC || 300), 30);
    console.log(`[Zoho CRM & Emails] Auto-sync enabled. Polling every ${zohoIntervalSec}s.`);

    const runZohoSyncChain = async (label = 'Periodic') => {
      try {
        const crmRes = await syncZohoCrm();
        if (label === 'Initial' || crmRes?.inserted > 0 || crmRes?.updated > 0) {
          console.log(`[Zoho CRM] ${label} sync:`, crmRes);
        }
      } catch (err) {
        console.warn(`[Zoho CRM] ${label} sync error:`, err.message);
      }

      try {
        const acctRes = await syncZohoAccounts();
        if (label === 'Initial' || acctRes?.inserted > 0 || acctRes?.updated > 0) {
          console.log(`[Zoho Accounts] ${label} sync:`, acctRes);
        }
      } catch (err) {
        console.warn(`[Zoho Accounts] ${label} sync error:`, err.message);
      }

      try {
        const emailRes = await syncZohoEmails();
        if (label === 'Initial' || emailRes?.inserted > 0 || emailRes?.updated > 0) {
          console.log(`[Zoho Emails] ${label} sync:`, emailRes);
        }
      } catch (err) {
        console.warn(`[Zoho Emails] ${label} sync error:`, err.message);
      }
    };

    void runZohoSyncChain('Initial');

    setInterval(() => {
      void runZohoSyncChain('Periodic');
    }, zohoIntervalSec * 1000);
  }
});

export { app };
