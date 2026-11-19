import cors from 'cors';
import express from 'express';
import {
  createExecutive,
  deleteExecutive,
  getCallById,
  getDashboardData,
  getLatestWebhookEvent,
  getLeadById,
  listActivities,
  listCalls,
  listCampaignFeed,
  listExecutives,
  listLeads,
  listWebhookEvents,
} from './db.js';
import { receiveManyreachWebhook } from './services/manyreachWebhook.js';
import { syncManyreachEvents } from './jobs/manyreachSyncSkeleton.js';
import { getZohoSettings } from './services/zohoBridge.js';
import { syncZohoCrm, syncZohoAccounts, getZohoAccountsPayload } from './services/zohoSync.js';
import {
  getZohoEmailsPayload,
  syncZohoEmails,
  receiveZohoEmailWebhook,
} from './services/zohoEmailSync.js';
import {
  getWhatsAppFeedPayload,
  receiveWhatsAppSync,
  simulateWhatsAppMessage,
} from './services/whatsappSync.js';
import {
  getWhatsAppSessionsStatus,
  startExecutiveWhatsAppSession,
  disconnectExecutiveWhatsAppSession,
} from './services/whatsappBridge.js';

function requireManyreachToken(req, res) {
  const expected = process.env.MANYREACH_WEBHOOK_SECRET || '';
  const provided = String(req.query.token || '');

  if (!expected) {
    res.status(503).json({
      success: false,
      message: 'MANYREACH_WEBHOOK_SECRET is not configured',
    });
    return false;
  }

  if (!provided || provided !== expected) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }

  return true;
}

function parseWebhookBody(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return { raw: String(raw), malformed: true };
  }
}

export function createApp({ sendEvent = () => {} } = {}) {
  const app = express();
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

  app.post(
    '/api/webhooks/manyreach',
    express.text({ type: '*/*', limit: '2mb' }),
    (req, res) => {
      if (!requireManyreachToken(req, res)) return;

      const parsed = parseWebhookBody(req.body);
      const result = receiveManyreachWebhook(parsed);

      return res.status(200).json({
        success: true,
        data: {
          received: true,
          webhookId: result.webhookId,
          inserted: Boolean(result.inserted),
          duplicate: Boolean(result.duplicate),
        },
      });
    },
  );

  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    return res.json({
      ok: true,
      service: 'climeto-intelligence-workspace',
      database: 'sqlite',
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

  app.get('/api/campaigns/feed', (req, res) => {
    const limit = Number(req.query.limit || 50);
    const since = String(req.query.since || '').trim();
    const feed = listCampaignFeed({ limit, since });
    return res.json({ success: true, data: feed.items, meta: feed.meta });
  });

  app.all('/api/campaigns/sync', async (_req, res) => {
    try {
      const result = await syncManyreachEvents();
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/webhooks/manyreach/debug', (req, res) => {
    if (!requireManyreachToken(req, res)) return;

    const limit = Number(req.query.limit || 10);
    const latest = getLatestWebhookEvent('manyreach');
    const events = listWebhookEvents({ source: 'manyreach', limit });

    return res.json({
      success: true,
      data: {
        latest,
        events,
        tip: 'Use latest.payload keys to refine normalizeManyreachEvent in manyreachMapper.js',
      },
    });
  });

  app.get('/api/settings/zoho', (_req, res) => {
    return res.json({ success: true, data: getZohoSettings() });
  });

  app.all('/api/settings/zoho/sync', async (_req, res) => {
    try {
      const result = await syncZohoCrm();
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/zoho/accounts', (req, res) => {
    const search = String(req.query.search || '').trim();
    return res.json({ success: true, data: getZohoAccountsPayload({ search }) });
  });

  app.all('/api/zoho/accounts/sync', async (_req, res) => {
    try {
      const result = await syncZohoAccounts();
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/zoho/emails', (req, res) => {
    const filters = {
      executive: String(req.query.executive || '').trim(),
      direction: String(req.query.direction || '').trim(),
      search: String(req.query.search || '').trim(),
      limit: Number(req.query.limit || 50),
    };
    return res.json({ success: true, data: getZohoEmailsPayload(filters) });
  });

  app.all('/api/zoho/emails/sync', async (_req, res) => {
    try {
      const result = await syncZohoEmails();
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/webhooks/zoho-emails', (req, res) => {
    try {
      const result = receiveZohoEmailWebhook(req.body);
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.get('/api/whatsapp/messages', (req, res) => {
    const filters = {
      search: String(req.query.search || '').trim(),
      direction: String(req.query.direction || '').trim(),
      executive: String(req.query.executive || '').trim(),
      leadId: String(req.query.leadId || '').trim(),
      phone: String(req.query.phone || '').trim(),
      limit: Number(req.query.limit || 100),
    };
    return res.json({ success: true, data: getWhatsAppFeedPayload(filters) });
  });

  app.post('/api/whatsapp/sync', (req, res) => {
    try {
      const result = receiveWhatsAppSync(req.body);
      sendEvent('whatsapp.received', {
        id: result.message.id,
        lead_id: result.message.lead_id,
        client_name: result.message.client_name,
        client_phone: result.message.client_phone,
        executive_name: result.message.executive_name,
        direction: result.message.direction,
        message: result.message.message,
        timestamp: result.message.timestamp,
      });
      return res.status(201).json({ success: true, data: result.message });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/dev/simulate-whatsapp', (req, res) => {
    try {
      const saved = simulateWhatsAppMessage(req.body || {});
      sendEvent('whatsapp.received', {
        id: saved.id,
        lead_id: saved.lead_id,
        client_name: saved.client_name,
        client_phone: saved.client_phone,
        executive_name: saved.executive_name,
        direction: saved.direction,
        message: saved.message,
        timestamp: saved.timestamp,
      });
      return res.status(201).json({ success: true, data: saved });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/whatsapp/sessions', (_req, res) => {
    return res.json({ success: true, data: getWhatsAppSessionsStatus() });
  });

  app.post('/api/whatsapp/sessions/:executiveId/start', async (req, res) => {
    try {
      const result = await startExecutiveWhatsAppSession(req.params.executiveId, { sendEvent });
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/whatsapp/sessions/:executiveId/disconnect', async (req, res) => {
    try {
      const result = await disconnectExecutiveWhatsAppSession(req.params.executiveId, { sendEvent });
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/executives', (_req, res) => {
    return res.json({ success: true, data: listExecutives() });
  });

  app.post('/api/executives', (req, res) => {
    try {
      const created = createExecutive(req.body || {});
      return res.status(201).json({ success: true, data: created });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.delete('/api/executives/:id', async (req, res) => {
    try {
      await disconnectExecutiveWhatsAppSession(req.params.id, { sendEvent }).catch(() => {});
      const removed = deleteExecutive(req.params.id);
      if (!removed) {
        return res.status(404).json({ success: false, message: 'Executive not found' });
      }
      return res.json({ success: true, data: { deleted: true, id: req.params.id } });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  return app;
}
