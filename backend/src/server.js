import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { createCompletedCall, getCallById, getDashboardData, getLeadById, initializeDb, listActivities, listCalls, listLeads } from './db.js';
import { createSupabaseBridge } from './services/supabaseBridge.js';
import { getZohoSettings } from './services/zohoBridge.js';

dotenv.config();

await initializeDb();

const app = express();
const port = Number(process.env.PORT || 4200);
const eventClients = new Set();
const allowedOrigins = (
  process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean)
    : ['http://localhost:5173', 'http://127.0.0.1:5173']
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('CORS not allowed'));
    },
  }),
);
app.use(express.json());

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

app.get('/api/health', (_req, res) => {
  return res.json({
    ok: true,
    service: 'climeto-intelligence-workspace',
    database: 'sqlite',
  });
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

app.get('/api/dashboard', (_req, res) => {
  return res.json({ success: true, data: getDashboardData() });
});

app.get('/api/calls', (req, res) => {
  const data = listCalls({
    search: String(req.query.search || '').trim(),
    platform: String(req.query.platform || '').trim(),
    stage: String(req.query.stage || '').trim(),
  });
  return res.json({ success: true, data });
});

app.get('/api/calls/:id', (req, res) => {
  const call = getCallById(req.params.id);
  if (!call) {
    return res.status(404).json({ success: false, message: 'Call not found' });
  }
  return res.json({ success: true, data: call });
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

app.get('/api/leads', (_req, res) => {
  return res.json({ success: true, data: listLeads() });
});

app.get('/api/leads/:id', (req, res) => {
  const data = getLeadById(req.params.id);
  if (!data) {
    return res.status(404).json({ success: false, message: 'Lead not found' });
  }
  return res.json({ success: true, data });
});

app.get('/api/activities', (req, res) => {
  const platform = String(req.query.platform || '').trim();
  return res.json({ success: true, data: listActivities(platform) });
});

app.get('/api/settings/zoho', (_req, res) => {
  return res.json({ success: true, data: getZohoSettings() });
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
});
