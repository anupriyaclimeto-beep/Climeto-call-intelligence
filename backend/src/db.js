import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import { runMigrations } from './migrations/index.js';
import { activities, calls, devices, leads, users } from './seedData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');
const dbPath = path.resolve(
  backendRoot,
  process.env.SQLITE_DB_PATH || './data/workspace.db',
);

const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}
const shouldSeedSampleData = process.env.WORKSPACE_SAMPLE_DATA === 'true';

let db;

export function persistDb() {
  if (!db) return;
  const bytes = db.export();
  fs.writeFileSync(dbPath, Buffer.from(bytes));
}

function run(query, params = []) {
  db.run(query, params);
}

function execute(query, params = []) {
  const statement = db.prepare(query);
  statement.run(params);
  statement.free();
}

function all(query, params = []) {
  const statement = db.prepare(query);
  statement.bind(params);
  const rows = [];

  while (statement.step()) {
    rows.push(statement.getAsObject());
  }

  statement.free();
  return rows;
}

function get(query, params = []) {
  return all(query, params)[0] || null;
}

function parseCall(row) {
  return {
    ...row,
    score: row.score_json ? JSON.parse(row.score_json) : null,
  };
}

function sanitizePhone(value = '') {
  return String(value).trim().replace(/\s+/g, '');
}

export async function initializeDb() {
  const SQL = await initSqlJs();
  const fileBuffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  db = fileBuffer?.length ? new SQL.Database(fileBuffer) : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      employee_name TEXT,
      employee_phone TEXT
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      client_phone TEXT,
      email TEXT,
      company TEXT,
      stage TEXT,
      owner_id TEXT,
      hotness TEXT,
      latest_summary TEXT,
      next_action TEXT,
      zoho_url TEXT
    );

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      user_id TEXT,
      device_id TEXT,
      executive_name TEXT,
      client_name TEXT,
      client_phone TEXT,
      direction TEXT,
      duration_seconds INTEGER,
      created_at TEXT,
      status TEXT,
      sentiment TEXT,
      summary TEXT,
      promise TEXT,
      next_action TEXT,
      transcript TEXT,
      score_json TEXT
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      platform TEXT,
      title TEXT,
      detail TEXT,
      created_at TEXT
    );
  `);

  // Versioned migrations (webhook_events, campaign_events, indexes).
  runMigrations(db, { persist: persistDb });

  const row = get('SELECT COUNT(*) AS count FROM calls');
  if ((row?.count ?? 0) === 0 && (shouldSeedSampleData || process.env.NODE_ENV !== 'production')) {
    seedLocalData();
  }

  // Mark/copy old campaign activities into campaign_events as is_seeded=1 (idempotent).
  backfillSeededCampaignEvents();
  persistDb();
}

function seedLocalData() {

  const insertUser = db.prepare(
    'INSERT INTO users (id, name, email, role) VALUES (?, ?, ?, ?)',
  );
  users.forEach((item) => {
    insertUser.run([item.id, item.name, item.email, item.role]);
  });
  insertUser.free();

  const insertDevice = db.prepare(
    'INSERT INTO devices (id, user_id, employee_name, employee_phone) VALUES (?, ?, ?, ?)',
  );
  devices.forEach((item) => {
    insertDevice.run([item.id, item.userId, item.employeeName, item.employeePhone]);
  });
  insertDevice.free();

  const insertLead = db.prepare(
    `INSERT INTO leads
     (id, client_name, client_phone, email, company, stage, owner_id, hotness, latest_summary, next_action, zoho_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  leads.forEach((item) => {
    insertLead.run([
      item.id,
      item.clientName,
      item.clientPhone,
      item.email,
      item.company,
      item.stage,
      item.ownerId,
      item.hotness,
      item.latestSummary,
      item.nextAction,
      item.zohoUrl,
    ]);
  });
  insertLead.free();

  const insertCall = db.prepare(
    `INSERT INTO calls
     (id, lead_id, user_id, device_id, executive_name, client_name, client_phone, direction, duration_seconds, created_at, status, sentiment, summary, promise, next_action, transcript, score_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  calls.forEach((item) => {
    insertCall.run([
      item.id,
      item.leadId,
      item.userId,
      item.deviceId,
      item.executiveName,
      item.clientName,
      item.clientPhone,
      item.direction,
      item.durationSeconds,
      item.createdAt,
      item.status,
      item.sentiment,
      item.summary,
      item.promise,
      item.nextAction,
      item.transcript,
      JSON.stringify(item.score),
    ]);
  });
  insertCall.free();

  const insertActivity = db.prepare(
    'INSERT INTO activities (id, lead_id, platform, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  activities.forEach((item) => {
    insertActivity.run([
      item.id,
      item.leadId,
      item.platform,
      item.title,
      item.detail,
      item.createdAt,
    ]);
  });
  insertActivity.free();
}

function inferSeededEventType(title, detail) {
  const text = `${title || ''} ${detail || ''}`.toLowerCase();
  if (text.includes('click')) return 'clicked';
  if (text.includes('open')) return 'opened';
  if (text.includes('reply') || text.includes('replied')) return 'replied';
  if (text.includes('bounce')) return 'bounced';
  if (text.includes('sent') || text.includes('send')) return 'sent';
  if (text.includes('no engagement')) return 'opened';
  return 'opened';
}

/** Copy platform=campaign activities into campaign_events with is_seeded=1. */
export function backfillSeededCampaignEvents() {
  const activityRows = all(
    `SELECT a.id, a.lead_id, a.title, a.detail, a.created_at,
            l.client_name, l.email, l.client_phone
     FROM activities a
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE a.platform = 'campaign'`,
  );

  const insert = db.prepare(
    `INSERT OR IGNORE INTO campaign_events
     (id, external_id, channel, source, lead_id, lead_name, lead_email, lead_phone,
      campaign_name, event_type, title, description, occurred_at, is_seeded)
     VALUES (?, ?, 'email', 'seed', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );

  for (const row of activityRows) {
    insert.run([
      `ce-seed-${row.id}`,
      `seed:${row.id}`,
      row.lead_id || null,
      row.client_name || null,
      row.email ? String(row.email).trim().toLowerCase() : null,
      row.client_phone || null,
      'Seeded campaign',
      inferSeededEventType(row.title, row.detail),
      row.title || 'Campaign activity',
      row.detail || '',
      row.created_at || new Date().toISOString(),
    ]);
  }
  insert.free();
}

function buildWhere({ search = '', platform = '', stage = '' }) {
  const conditions = ['1=1'];
  const params = [];

  if (search) {
    conditions.push('(c.client_name LIKE ? OR c.client_phone LIKE ? OR c.executive_name LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  if (platform) {
    conditions.push('c.lead_id IN (SELECT lead_id FROM activities WHERE platform = ?)');
    params.push(platform);
  }

  if (stage) {
    conditions.push('c.lead_id IN (SELECT id FROM leads WHERE stage = ?)');
    params.push(stage);
  }

  return { where: conditions.join(' AND '), params };
}

export function getDashboardData() {
  const stats = get(
    `SELECT
      (SELECT COUNT(*) FROM calls) AS total_calls,
      (SELECT COUNT(*) FROM calls WHERE strftime('%Y-%m', created_at) = '2026-11') AS november_calls,
      (SELECT COUNT(*) FROM leads) AS total_leads,
      (SELECT COUNT(*) FROM leads WHERE hotness = 'hot') AS hot_leads,
      (SELECT COUNT(*) FROM calls WHERE promise NOT IN ('No promise', 'No firm promise')) AS promises,
      (SELECT COUNT(*) FROM activities WHERE platform = 'whatsapp') AS whatsapp_events,
      (SELECT COUNT(*) FROM activities WHERE platform = 'email') AS email_events`,
  );

  const recent = all(
    `SELECT id, executive_name, client_name, client_phone, summary, promise, next_action, created_at
     FROM calls
     ORDER BY created_at DESC
     LIMIT 5`,
  );

  return { stats, recent };
}

export function listCalls(filters = {}) {
  const { where, params } = buildWhere(filters);
  return all(
    `SELECT c.*, l.stage, l.hotness, l.zoho_url
     FROM calls c
     LEFT JOIN leads l ON l.id = c.lead_id
     WHERE ${where}
     ORDER BY c.created_at DESC`,
    params,
  ).map(parseCall);
}

export function getCallById(id) {
  const row = get(
    `SELECT c.*, l.stage, l.hotness, l.zoho_url
     FROM calls c
     LEFT JOIN leads l ON l.id = c.lead_id
     WHERE c.id = ?`,
    [id],
  );

  return row ? parseCall(row) : null;
}

export function listLeads() {
  return all(
    `SELECT l.*,
      (SELECT COUNT(*) FROM calls c WHERE c.lead_id = l.id) AS call_count,
      (SELECT MAX(created_at) FROM activities a WHERE a.lead_id = l.id) AS last_activity_at
     FROM leads l
     ORDER BY last_activity_at DESC, client_name ASC`,
  );
}

export function getLeadById(id) {
  const lead = get('SELECT * FROM leads WHERE id = ?', [id]);
  if (!lead) return null;

  const leadCalls = all(
    'SELECT * FROM calls WHERE lead_id = ? ORDER BY created_at DESC',
    [id],
  ).map(parseCall);

  const leadActivities = all(
    'SELECT * FROM activities WHERE lead_id = ? ORDER BY created_at DESC',
    [id],
  );

  const timeline = [
    ...leadCalls.map((call) => ({
      id: `timeline-${call.id}`,
      platform: 'call',
      title: `${call.executive_name} -> ${call.client_name}`,
      detail: `${call.summary} | Promise: ${call.promise}`,
      created_at: call.created_at,
      source_id: call.id,
    })),
    ...leadActivities,
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return { lead, calls: leadCalls, activities: leadActivities, timeline };
}

export function listActivities(platform = '') {
  const params = [];
  let query = `
    SELECT a.*, l.client_name, l.client_phone
    FROM activities a
    LEFT JOIN leads l ON l.id = a.lead_id
  `;

  if (platform) {
    query += ' WHERE a.platform = ?';
    params.push(platform);
  }

  query += ' ORDER BY a.created_at DESC';
  return all(query, params);
}


export function findLeadByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return get(
    `SELECT * FROM leads
     WHERE lower(trim(email)) = ?
     LIMIT 1`,
    [normalized],
  );
}

export function insertWebhookEvent({ id, source, payload, receivedAt, processed = 0, error = null }) {
  run(
    `INSERT INTO webhook_events (id, source, payload, received_at, processed, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, source, payload, receivedAt, processed, error],
  );
}

export function markWebhookProcessed(id, { processed = 1, error = null } = {}) {
  run(
    `UPDATE webhook_events
     SET processed = ?, error = ?
     WHERE id = ?`,
    [processed, error, id],
  );
}

export function listWebhookEvents({ source = '', limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const params = [];
  let query = `SELECT id, source, payload, received_at, processed, error FROM webhook_events`;

  if (source) {
    query += ' WHERE source = ?';
    params.push(source);
  }

  query += ' ORDER BY received_at DESC LIMIT ?';
  params.push(safeLimit);
  return all(query, params).map((row) => {
    let parsed = row.payload;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      // keep raw string
    }
    return { ...row, payload: parsed };
  });
}

export function getLatestWebhookEvent(source = 'manyreach') {
  return listWebhookEvents({ source, limit: 1 })[0] || null;
}

/**
 * INSERT OR IGNORE on external_id uniqueness.
 * Returns { inserted, duplicate, id }.
 */
export function insertCampaignEvent(event) {
  const before = get(
    'SELECT id FROM campaign_events WHERE external_id = ? LIMIT 1',
    [event.externalId],
  );
  if (before) {
    return { inserted: false, duplicate: true, id: before.id };
  }

  run(
    `INSERT OR IGNORE INTO campaign_events
     (id, external_id, channel, source, lead_id, lead_name, lead_email, lead_phone,
      campaign_name, event_type, title, description, occurred_at, is_seeded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.externalId,
      event.channel || 'email',
      event.source || 'manyreach',
      event.leadId || null,
      event.leadName || null,
      event.leadEmail || null,
      event.leadPhone || null,
      event.campaignName || null,
      event.eventType,
      event.title || null,
      event.description || null,
      event.occurredAt,
      event.isSeeded ? 1 : 0,
    ],
  );

  const after = get(
    'SELECT id FROM campaign_events WHERE external_id = ? LIMIT 1',
    [event.externalId],
  );

  return {
    inserted: Boolean(after) && after.id === event.id,
    duplicate: Boolean(after) && after.id !== event.id,
    id: after?.id || event.id,
  };
}

export function countRealCampaignEvents() {
  const row = get(
    `SELECT COUNT(*) AS count FROM campaign_events WHERE is_seeded = 0`,
  );
  return row?.count ?? 0;
}

export function listCampaignFeed({ limit = 50, since = '' } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const showSeeded =
    String(process.env.SHOW_SEEDED_CAMPAIGNS || 'false').toLowerCase() === 'true';

  const conditions = ['1=1'];
  const params = [];

  if (!showSeeded) {
    conditions.push('is_seeded = 0');
  }

  if (since) {
    conditions.push('occurred_at > ?');
    params.push(String(since));
  }

  const rows = all(
    `SELECT
      id,
      lead_id,
      lead_name,
      lead_phone AS phone,
      lead_email AS email,
      campaign_name,
      event_type,
      title,
      description,
      occurred_at,
      is_seeded,
      source,
      channel
     FROM campaign_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY occurred_at DESC
     LIMIT ?`,
    [...params, safeLimit],
  );

  return {
    items: rows,
    meta: {
      showSeeded,
      realEventCount: countRealCampaignEvents(),
      live: countRealCampaignEvents() > 0,
    },
  };
}

/** Test helper: wipe only Manyreach-related rows without touching core seed tables. */
export function resetManyreachTestData() {
  run(`DELETE FROM campaign_events WHERE is_seeded = 0`);
  run(`DELETE FROM webhook_events WHERE source = 'manyreach'`);
  persistDb();

}


export function createCompletedCall(payload = {}) {
  const clientPhone = sanitizePhone(payload.clientPhone || payload.client_phone || '');
  const email = String(payload.email || '').trim();
  const clientName = String(payload.clientName || payload.client_name || 'New Prospect').trim();
  const executiveName = String(payload.executiveName || payload.executive_name || 'Ambuj Pathak').trim();
  const summary = String(payload.summary || 'Call completed. Summary pending.').trim();
  const promise = String(payload.promise || 'Pending follow-up').trim();
  const nextAction = String(
    payload.nextAction || payload.next_action || 'Review completed call and plan follow-up.',
  ).trim();
  const transcript = String(payload.transcript || 'Transcript pending.').trim();
  const sentiment = String(payload.sentiment || 'Neutral').trim();
  const direction = String(payload.direction || 'Outgoing').trim();
  const status = String(payload.status || 'completed').trim();
  const durationSeconds = Number(payload.durationSeconds || payload.duration_seconds || 0);
  const createdAt = payload.createdAt || payload.created_at || new Date().toISOString();
  const scoreJson = payload.score ? JSON.stringify(payload.score) : null;
  const callId = String(payload.id || `call-${randomUUID().slice(0, 8)}`).trim();

  let lead = null;
  if (clientPhone) {
    lead = get('SELECT * FROM leads WHERE client_phone = ? LIMIT 1', [clientPhone]);
  }
  if (!lead && email) {
    lead = get('SELECT * FROM leads WHERE email = ? LIMIT 1', [email]);
  }

  const defaultUser = get('SELECT id, name FROM users ORDER BY rowid ASC LIMIT 1');
  const defaultDevice = get('SELECT id FROM devices ORDER BY rowid ASC LIMIT 1');
  const leadId = lead?.id || `lead-${randomUUID().slice(0, 8)}`;

  if (!lead) {
    execute(
      `INSERT INTO leads
       (id, client_name, client_phone, email, company, stage, owner_id, hotness, latest_summary, next_action, zoho_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId,
        clientName,
        clientPhone,
        email,
        payload.company || clientName,
        payload.stage || 'Contacted',
        payload.ownerId || defaultUser?.id || 'u-ambuj',
        payload.hotness || 'warm',
        summary,
        nextAction,
        payload.zohoUrl || '',
      ],
    );
  } else {
    execute(
      `UPDATE leads
       SET client_name = ?, client_phone = ?, email = ?, latest_summary = ?, next_action = ?, stage = COALESCE(?, stage), hotness = COALESCE(?, hotness)
       WHERE id = ?`,
      [
        clientName || lead.client_name,
        clientPhone || lead.client_phone,
        email || lead.email,
        summary,
        nextAction,
        payload.stage || null,
        payload.hotness || null,
        leadId,
      ],
    );
  }

  const existingCall = get('SELECT id FROM calls WHERE id = ? LIMIT 1', [callId]);

  if (existingCall) {
    execute(
      `UPDATE calls
       SET lead_id = ?, user_id = ?, device_id = ?, executive_name = ?, client_name = ?, client_phone = ?, direction = ?, duration_seconds = ?, created_at = ?, status = ?, sentiment = ?, summary = ?, promise = ?, next_action = ?, transcript = ?, score_json = ?
       WHERE id = ?`,
      [
        leadId,
        payload.userId || defaultUser?.id || 'u-ambuj',
        payload.deviceId || defaultDevice?.id || 'd-ambuj-1',
        executiveName,
        clientName,
        clientPhone,
        direction,
        durationSeconds,
        createdAt,
        status,
        sentiment,
        summary,
        promise,
        nextAction,
        transcript,
        scoreJson,
        callId,
      ],
    );
  } else {
    execute(
      `INSERT INTO calls
       (id, lead_id, user_id, device_id, executive_name, client_name, client_phone, direction, duration_seconds, created_at, status, sentiment, summary, promise, next_action, transcript, score_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        callId,
        leadId,
        payload.userId || defaultUser?.id || 'u-ambuj',
        payload.deviceId || defaultDevice?.id || 'd-ambuj-1',
        executiveName,
        clientName,
        clientPhone,
        direction,
        durationSeconds,
        createdAt,
        status,
        sentiment,
        summary,
        promise,
        nextAction,
        transcript,
        scoreJson,
      ],
    );
  }

  persistDb();
  return getCallById(callId);
}

export function upsertLeadFromZoho(data) {
  const phone = sanitizePhone(data.clientPhone || data.phone || '');
  const email = String(data.email || '').trim().toLowerCase();
  const id = String(data.id || '').trim();

  let existing = null;
  if (id) {
    existing = get('SELECT * FROM leads WHERE id = ? LIMIT 1', [id]);
  }
  if (!existing && phone) {
    existing = get('SELECT * FROM leads WHERE client_phone = ? LIMIT 1', [phone]);
  }
  if (!existing && email) {
    existing = get('SELECT * FROM leads WHERE lower(trim(email)) = ? LIMIT 1', [email]);
  }

  const targetId = existing?.id || id || `zoho-lead-${randomUUID().slice(0, 8)}`;
  const clientName = data.clientName || existing?.client_name || 'Zoho Lead';
  const company = data.company || existing?.company || clientName;
  const stage = data.stage || existing?.stage || 'Contacted';
  const ownerId = data.ownerId || existing?.owner_id || 'Zoho User';
  const hotness = data.hotness || existing?.hotness || 'warm';
  const latestSummary = data.latestSummary || existing?.latest_summary || 'Synced from Zoho CRM';
  const nextAction = data.nextAction || existing?.next_action || 'Follow up with lead';
  const zohoUrl = data.zohoUrl || existing?.zoho_url || '';

  if (existing) {
    run(
      `UPDATE leads
       SET client_name = ?, client_phone = COALESCE(NULLIF(?, ''), client_phone),
           email = COALESCE(NULLIF(?, ''), email), company = ?, stage = ?,
           owner_id = ?, hotness = ?, zoho_url = COALESCE(NULLIF(?, ''), zoho_url)
       WHERE id = ?`,
      [clientName, phone, email, company, stage, ownerId, hotness, zohoUrl, existing.id]
    );
    return { inserted: false, updated: true, id: existing.id };
  } else {
    run(
      `INSERT INTO leads
       (id, client_name, client_phone, email, company, stage, owner_id, hotness, latest_summary, next_action, zoho_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [targetId, clientName, phone, email, company, stage, ownerId, hotness, latestSummary, nextAction, zohoUrl]
    );
    return { inserted: true, updated: false, id: targetId };
  }
}
