import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { getCallById, getDashboardData, getLeadById, initializeDb, listActivities, listCalls, listLeads } from './db.js';
import { getZohoSettings } from './services/zohoBridge.js';

dotenv.config();

await initializeDb();

const app = express();
const port = Number(process.env.PORT || 4200);
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

app.get('/api/settings/zoho', (_req, res) => {
  return res.json({ success: true, data: getZohoSettings() });
});

app.listen(port, () => {
  console.log(`Workspace API running on http://localhost:${port}`);
});
