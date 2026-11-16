import cors from 'cors';
import express from 'express';
import {
  getCallById,
  getDashboardData,
  getLatestWebhookEvent,
  getLeadById,
  listActivities,
  listCalls,
  listCampaignFeed,
  listLeads,
  listWebhookEvents,
} from './db.js';
import { receiveManyreachWebhook } from './services/manyreachWebhook.js';
import { syncManyreachEvents } from './jobs/manyreachSyncSkeleton.js';
import { getZohoSettings } from './services/zohoBridge.js';

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

export function createApp() {
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

  return app;
}
