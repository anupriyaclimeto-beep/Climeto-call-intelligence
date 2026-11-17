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

export function all(query, params = []) {
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
  seedZohoAccountsIfEmpty();
  seedZohoEmailsIfEmpty();
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

  const recentLeads = all(
    `SELECT id, client_name, client_phone, company, stage, hotness, latest_summary, next_action, zoho_url
     FROM leads
     ORDER BY rowid DESC
     LIMIT 6`,
  );

  return { stats, recent, recentLeads };
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

export function seedZohoAccountsIfEmpty() {
  try {
    const row = get('SELECT COUNT(*) AS count FROM zoho_accounts');
    if ((row?.count ?? 0) === 0) {
      const seedAccounts = [
        {
          id: 'zoho-acc-101',
          accountName: 'Climeto Global Technologies',
          phone: '+91 98112 34567',
          website: 'https://climeto.com',
          industry: 'IT & Climate Tech',
          annualRevenue: '₹12,50,00,000',
          billingCity: 'New Delhi',
          billingCountry: 'India',
          ownerName: 'Ambuj Sharma',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Accounts',
        },
        {
          id: 'zoho-acc-102',
          accountName: 'Apex Solar Solutions',
          phone: '+91 98234 56789',
          website: 'https://apexsolar.in',
          industry: 'Renewable Energy',
          annualRevenue: '₹8,40,00,000',
          billingCity: 'Bengaluru',
          billingCountry: 'India',
          ownerName: 'Sahil Patel',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Accounts',
        },
        {
          id: 'zoho-acc-103',
          accountName: 'GreenGrid Power Systems',
          phone: '+91 97123 45678',
          website: 'https://greengrid.org',
          industry: 'Clean Energy & Power',
          annualRevenue: '₹24,00,00,000',
          billingCity: 'Mumbai',
          billingCountry: 'India',
          ownerName: 'Riya Sen',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Accounts',
        },
        {
          id: 'zoho-acc-104',
          accountName: 'BioFuture Carbon Offsets',
          phone: '+91 96543 21098',
          website: 'https://biofuture.io',
          industry: 'Environmental Services',
          annualRevenue: '₹5,20,00,000',
          billingCity: 'Pune',
          billingCountry: 'India',
          ownerName: 'Ambuj Sharma',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Accounts',
        },
        {
          id: 'zoho-acc-105',
          accountName: 'Sterling Steel & Infra Ltd',
          phone: '+91 99887 76655',
          website: 'https://sterlingsteel.co',
          industry: 'Heavy Manufacturing',
          annualRevenue: '₹45,00,00,000',
          billingCity: 'Ahmedabad',
          billingCountry: 'India',
          ownerName: 'Sahil Patel',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Accounts',
        },
      ];

      const insert = db.prepare(
        `INSERT OR IGNORE INTO zoho_accounts
         (id, account_name, phone, website, industry, annual_revenue, billing_city, billing_country, owner_name, zoho_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (const a of seedAccounts) {
        insert.run([
          a.id,
          a.accountName,
          a.phone,
          a.website,
          a.industry,
          a.annualRevenue,
          a.billingCity,
          a.billingCountry,
          a.ownerName,
          a.zohoUrl,
          now,
          now,
        ]);
      }
      insert.free();
    }

    const metaRow = get('SELECT id FROM zoho_account_meta WHERE id = ?', ['current_meta']);
    if (!metaRow) {
      run(
        `INSERT OR IGNORE INTO zoho_account_meta
         (id, user_name, user_email, zuid, org_name, org_id, role, account_url, status, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'current_meta',
          'Climeto Workspace User',
          'admin@climeto.com',
          '60029188471',
          'Climeto Global Ltd',
          '700192841',
          'Super Administrator',
          'https://accounts.zoho.in',
          'Ready (OAuth 2.0)',
          new Date().toISOString(),
        ],
      );
    }
  } catch (err) {
    console.warn('[Zoho DB] Notice in seedZohoAccountsIfEmpty:', err.message);
  }
}

export function upsertZohoAccount(data) {
  const id = String(data.id || '').trim();
  if (!id) return null;
  const accountName = String(data.accountName || data.name || '').trim() || 'Unnamed Company';
  const phone = String(data.phone || '').trim();
  const website = String(data.website || '').trim();
  const industry = String(data.industry || '').trim();
  const annualRevenue = String(data.annualRevenue || data.revenue || '').trim();
  const billingCity = String(data.billingCity || data.city || '').trim();
  const billingCountry = String(data.billingCountry || data.country || 'India').trim();
  const ownerName = String(data.ownerName || data.owner || 'Zoho User').trim();
  const zohoUrl = String(data.zohoUrl || '').trim();
  const now = new Date().toISOString();

  const existing = get('SELECT id FROM zoho_accounts WHERE id = ?', [id]);
  if (existing) {
    run(
      `UPDATE zoho_accounts
       SET account_name = ?, phone = ?, website = ?, industry = ?, annual_revenue = ?,
           billing_city = ?, billing_country = ?, owner_name = ?, zoho_url = ?, updated_at = ?
       WHERE id = ?`,
      [accountName, phone, website, industry, annualRevenue, billingCity, billingCountry, ownerName, zohoUrl, now, id],
    );
    return { id, inserted: false, updated: true };
  } else {
    run(
      `INSERT INTO zoho_accounts
       (id, account_name, phone, website, industry, annual_revenue, billing_city, billing_country, owner_name, zoho_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, accountName, phone, website, industry, annualRevenue, billingCity, billingCountry, ownerName, zohoUrl, now, now],
    );
    return { id, inserted: true, updated: false };
  }
}

export function listZohoAccounts(filters = {}) {
  const search = String(filters.search || '').trim().toLowerCase();
  let query = 'SELECT * FROM zoho_accounts';
  const params = [];
  if (search) {
    query += ' WHERE lower(account_name) LIKE ? OR lower(industry) LIKE ? OR lower(billing_city) LIKE ? OR lower(owner_name) LIKE ?';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  query += ' ORDER BY account_name ASC';
  return all(query, params);
}

export function saveZohoAccountMeta(meta = {}) {
  const id = 'current_meta';
  const userName = meta.userName || meta.user_name || 'Zoho User';
  const userEmail = meta.userEmail || meta.user_email || '';
  const zuid = String(meta.zuid || meta.user_id || '');
  const orgName = meta.orgName || meta.org_name || 'Climeto CRM Org';
  const orgId = String(meta.orgId || meta.org_id || '');
  const role = meta.role || 'Administrator';
  const accountUrl = meta.accountUrl || meta.account_url || 'https://accounts.zoho.in';
  const status = meta.status || 'Active';
  const now = new Date().toISOString();

  const existing = get('SELECT id FROM zoho_account_meta WHERE id = ?', [id]);
  if (existing) {
    run(
      `UPDATE zoho_account_meta
       SET user_name = ?, user_email = ?, zuid = ?, org_name = ?, org_id = ?, role = ?, account_url = ?, status = ?, last_synced_at = ?
       WHERE id = ?`,
      [userName, userEmail, zuid, orgName, orgId, role, accountUrl, status, now, id],
    );
  } else {
    run(
      `INSERT INTO zoho_account_meta
       (id, user_name, user_email, zuid, org_name, org_id, role, account_url, status, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userName, userEmail, zuid, orgName, orgId, role, accountUrl, status, now],
    );
  }
  persistDb();
  return getZohoAccountMeta();
}

export function getZohoAccountMeta() {
  const row = get('SELECT * FROM zoho_account_meta WHERE id = ?', ['current_meta']);
  if (!row) {
    return {
      user_name: 'Zoho Workspace Account',
      user_email: 'admin@climeto.com',
      zuid: '60029188471',
      org_name: 'Climeto Global Ltd',
      org_id: '700192841',
      role: 'Super Administrator',
      account_url: 'https://accounts.zoho.in',
      status: 'Ready for OAuth',
      last_synced_at: null,
    };
  }
  return row;
}

export function upsertZohoEmail(data) {
  const externalId = String(data.externalId || data.external_id || data.id || '').trim();
  const id = `ze-${externalId || randomUUID().slice(0, 8)}`;
  const executiveName = String(data.executiveName || data.executive_name || 'Zoho Executive').trim();
  const executiveEmail = String(data.executiveEmail || data.executive_email || '').trim().toLowerCase();
  const clientEmail = String(data.clientEmail || data.client_email || '').trim().toLowerCase();
  const clientName = String(data.clientName || data.client_name || '').trim();
  const direction = String(data.direction || 'outbound').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
  const subject = String(data.subject || 'No Subject').trim();
  const summary = String(data.summary || data.snippet || '').trim();
  const bodySnippet = String(data.bodySnippet || data.body_snippet || summary || '').trim();
  const sentAt = data.sentAt || data.sent_at || data.occurred_at || new Date().toISOString();
  const status = String(data.status || (direction === 'inbound' ? 'received' : 'sent')).trim();
  const zohoUrl = String(data.zohoUrl || data.zoho_url || '').trim();
  const now = new Date().toISOString();

  // Find matching lead by email if lead_id not explicitly provided
  let leadId = data.leadId || data.lead_id || null;
  let finalClientName = clientName;

  if (!leadId && clientEmail) {
    const matchedLead = get('SELECT id, client_name FROM leads WHERE lower(trim(email)) = ? LIMIT 1', [clientEmail]);
    if (matchedLead) {
      leadId = matchedLead.id;
      if (!finalClientName) finalClientName = matchedLead.client_name;
    }
  }

  // Check if existing
  const existing = externalId ? get('SELECT id FROM zoho_emails WHERE external_id = ?', [externalId]) : null;

  if (existing) {
    run(
      `UPDATE zoho_emails
       SET lead_id = COALESCE(?, lead_id), executive_name = ?, executive_email = ?,
           client_name = ?, client_email = ?, direction = ?, subject = ?,
           summary = ?, body_snippet = ?, sent_at = ?, status = ?, zoho_url = ?
       WHERE id = ?`,
      [
        leadId,
        executiveName,
        executiveEmail,
        finalClientName || 'Client',
        clientEmail,
        direction,
        subject,
        summary,
        bodySnippet,
        sentAt,
        status,
        zohoUrl,
        existing.id,
      ],
    );
    return { id: existing.id, inserted: false, updated: true };
  } else {
    run(
      `INSERT INTO zoho_emails
       (id, external_id, lead_id, executive_name, executive_email, client_name, client_email, direction, subject, summary, body_snippet, sent_at, status, zoho_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        externalId || id,
        leadId,
        executiveName,
        executiveEmail,
        finalClientName || 'Client',
        clientEmail,
        direction,
        subject,
        summary,
        bodySnippet,
        sentAt,
        status,
        zohoUrl,
        now,
      ],
    );

    // Also link into activities table if leadId exists so it appears in Lead 360 timeline!
    if (leadId) {
      const actId = `act-ze-${id}`;
      const actTitle =
        direction === 'outbound'
          ? `Email sent by ${executiveName}`
          : `Email received from ${finalClientName || clientEmail}`;
      const actDetail = `${subject}: ${summary || bodySnippet}`;
      run(
        `INSERT OR IGNORE INTO activities (id, lead_id, platform, title, detail, created_at)
         VALUES (?, ?, 'email', ?, ?, ?)`,
        [actId, leadId, actTitle, actDetail, sentAt],
      );
    }

    return { id, inserted: true, updated: false };
  }
}

export function listZohoEmails(filters = {}) {
  const { executive = '', direction = '', search = '', limit = 100 } = filters;
  const conditions = ['1=1'];
  const params = [];

  if (executive) {
    conditions.push('(lower(executive_name) LIKE ? OR lower(executive_email) LIKE ?)');
    const execTerm = `%${executive.toLowerCase()}%`;
    params.push(execTerm, execTerm);
  }

  if (direction) {
    conditions.push('lower(direction) = ?');
    params.push(direction.toLowerCase());
  }

  if (search) {
    conditions.push(
      '(lower(subject) LIKE ? OR lower(summary) LIKE ? OR lower(client_name) LIKE ? OR lower(client_email) LIKE ? OR lower(executive_name) LIKE ?)',
    );
    const searchTerm = `%${search.toLowerCase()}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
  }

  const query = `
    SELECT *
    FROM zoho_emails
    WHERE ${conditions.join(' AND ')}
    ORDER BY sent_at DESC
    LIMIT ?
  `;
  params.push(Number(limit) || 100);

  return all(query, params);
}

export function getZohoEmailsStats() {
  const row = get(`
    SELECT
      COUNT(*) AS total_emails,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_count,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_count,
      COUNT(DISTINCT executive_email) AS active_executives
    FROM zoho_emails
  `);

  const execRows = all(`
    SELECT executive_name, executive_email, COUNT(*) AS email_count
    FROM zoho_emails
    GROUP BY executive_email
    ORDER BY email_count DESC
  `);

  return {
    total: row?.total_emails || 0,
    outbound: row?.outbound_count || 0,
    inbound: row?.inbound_count || 0,
    activeExecutives: row?.active_executives || 0,
    executives: execRows,
  };
}

export function seedZohoEmailsIfEmpty() {
  try {
    const row = get('SELECT COUNT(*) AS count FROM zoho_emails');
    if ((row?.count ?? 0) === 0) {
      const sampleEmails = [
        {
          externalId: 'ze-msg-101',
          leadId: 'lead-1',
          executiveName: 'Ambuj Pathak',
          executiveEmail: 'ambuj@climeto.com',
          clientName: 'ABC Polymers',
          clientEmail: 'procurement@abcpolymers.in',
          direction: 'outbound',
          subject: 'Revised EPR Pricing Quotation - Climeto Global',
          summary: 'Shared customized quote for 500 MT plastic EPR credits at ₹4.20/kg.',
          bodySnippet:
            'Dear Procurement Team, As discussed on our call today, please find attached the revised quote for the 500 MT EPR fulfillment credits...',
          sentAt: '2026-11-16T14:30:00Z',
          status: 'opened',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Emails',
        },
        {
          externalId: 'ze-msg-102',
          leadId: 'lead-1',
          executiveName: 'Ambuj Pathak',
          executiveEmail: 'ambuj@climeto.com',
          clientName: 'ABC Polymers',
          clientEmail: 'procurement@abcpolymers.in',
          direction: 'inbound',
          subject: 'Re: Revised EPR Pricing Quotation - Climeto Global',
          summary: 'Client acknowledged quotation and requested compliance certificate samples.',
          bodySnippet:
            'Hi Ambuj, Thanks for sharing the quotation. The commercials look feasible. Could you also share a specimen certificate of CPCB compliance?',
          sentAt: '2026-11-16T16:15:00Z',
          status: 'replied',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Emails',
        },
        {
          externalId: 'ze-msg-103',
          leadId: 'lead-2',
          executiveName: 'Sahil Patel',
          executiveEmail: 'sahil@climeto.com',
          clientName: 'Vardhman Plastics',
          clientEmail: 'info@vardhmanplastics.in',
          direction: 'outbound',
          subject: 'Introduction to Plastic Waste Management Solutions - Climeto',
          summary: 'Introductory deck and category-wise audit checklist sent to plant manager.',
          bodySnippet:
            'Hello Vardhman Team, Following our preliminary phone discussion, I am forwarding the comprehensive brochure outlining our audit methodology...',
          sentAt: '2026-11-15T11:00:00Z',
          status: 'delivered',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Emails',
        },
        {
          externalId: 'ze-msg-104',
          leadId: 'lead-3',
          executiveName: 'Riya Sen',
          executiveEmail: 'riya@climeto.com',
          clientName: 'Shree Industries',
          clientEmail: 'admin@shreeindustries.in',
          direction: 'outbound',
          subject: 'Annual Carbon Footprint & ESG Assessment Offer',
          summary: 'Detailed savings calculation and proposal sent for review.',
          bodySnippet:
            'Dear Sir, Climeto is pleased to present our specialized industrial assessment framework designed to reduce regulatory compliance friction...',
          sentAt: '2026-11-14T10:45:00Z',
          status: 'opened',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Emails',
        },
        {
          externalId: 'ze-msg-105',
          leadId: 'lead-2',
          executiveName: 'Sahil Patel',
          executiveEmail: 'sahil@climeto.com',
          clientName: 'Vardhman Plastics',
          clientEmail: 'info@vardhmanplastics.in',
          direction: 'inbound',
          subject: 'Re: Introduction to Plastic Waste Management Solutions',
          summary: 'Client confirmed receipt and requested follow-up meeting on Friday.',
          bodySnippet:
            'Received with thanks. Our technical head will review the audit checklist and we can schedule a quick review this Friday afternoon.',
          sentAt: '2026-11-15T15:20:00Z',
          status: 'replied',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Emails',
        },
        {
          externalId: 'ze-msg-106',
          leadId: 'lead-1',
          executiveName: 'Ambuj Pathak',
          executiveEmail: 'ambuj@climeto.com',
          clientName: 'ABC Polymers',
          clientEmail: 'procurement@abcpolymers.in',
          direction: 'outbound',
          subject: 'Specimen Compliance Certificate & Next Steps',
          summary: 'Attached verified CPCB certificate and onboarding draft agreement.',
          bodySnippet:
            'Please find attached the specimen certificate issued by CPCB alongside our master onboarding agreement...',
          sentAt: '2026-11-17T09:10:00Z',
          status: 'sent',
          zohoUrl: 'https://crm.zoho.in/crm/tab/Emails',
        },
      ];

      for (const email of sampleEmails) {
        upsertZohoEmail(email);
      }
    }
  } catch (err) {
    console.warn('[Zoho DB] Notice in seedZohoEmailsIfEmpty:', err.message);
  }
}

