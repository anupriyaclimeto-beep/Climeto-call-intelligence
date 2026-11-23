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

export function get(query, params = []) {
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
  seedWhatsAppMessagesIfEmpty();
  purgeInvalidWhatsAppChannels();
  repairExistingWhatsAppLids();
  seedPlaybookIfEmpty();
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

export function listActivities(arg = '') {
  const platform = typeof arg === 'object' && arg !== null ? (arg.platform || '') : String(arg || '');
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

export function upsertWhatsAppMessage(data) {
  const externalId = String(data.externalId || data.external_id || data.id || '').trim();
  const id = `wa-${externalId || randomUUID().slice(0, 8)}`;
  const deviceId = String(data.deviceId || data.device_id || 'android-device').trim();
  const executiveName = String(data.executiveName || data.executive_name || 'Sales Executive').trim();
  const rawPhone = String(data.clientPhone || data.client_phone || '').trim();
  const clientPhone = sanitizePhone(rawPhone);
  let clientName = String(data.clientName || data.client_name || '').trim();
  const direction = String(data.direction || 'incoming').toLowerCase() === 'outgoing' ? 'outgoing' : 'incoming';
  const message = String(data.message || data.text || data.body || '').trim();
  const timestamp = data.timestamp || data.time || new Date().toISOString();
  const status = String(data.status || (direction === 'incoming' ? 'received' : 'sent'));

  // Attempt to match lead by phone (full or last 10 digits)
  let lead = null;
  if (clientPhone) {
    lead = get('SELECT * FROM leads WHERE client_phone = ? LIMIT 1', [clientPhone]);
    if (!lead) {
      const digits = clientPhone.replace(/\D/g, '');
      const last10 = digits.slice(-10);
      if (last10.length === 10) {
        lead = get('SELECT * FROM leads WHERE client_phone LIKE ? LIMIT 1', [`%${last10}`]);
      }
    }
  }

  // Auto-create a new CRM lead for brand-new WhatsApp-first contacts (Company Work SIM mode)
  const autoCreateLead = process.env.WHATSAPP_AUTO_CREATE_LEAD !== 'false';
  let createdNewLead = false;
  if (!lead && !data.leadId && !data.lead_id && clientPhone && autoCreateLead) {
    const newLeadId = `lead-wa-${randomUUID().slice(0, 8)}`;
    const displayName = clientName || clientPhone;
    const ownerRow =
      (data.ownerId ? get('SELECT id FROM users WHERE id = ?', [data.ownerId]) : null) ||
      get('SELECT id FROM users WHERE name LIKE ? LIMIT 1', [`%${executiveName}%`]) ||
      get('SELECT id FROM users ORDER BY rowid ASC LIMIT 1');

    run(
      `INSERT INTO leads
       (id, client_name, client_phone, email, company, stage, owner_id, hotness, latest_summary, next_action, zoho_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newLeadId,
        displayName,
        clientPhone,
        '',
        displayName,
        'Contacted',
        ownerRow?.id || 'u-ambuj',
        direction === 'incoming' ? 'hot' : 'warm',
        message ? `WhatsApp: ${message.slice(0, 100)}` : 'New WhatsApp inquiry',
        direction === 'incoming'
          ? 'Reply to WhatsApp inquiry and qualify lead'
          : 'Follow up on WhatsApp conversation',
        '',
      ],
    );
    lead = get('SELECT * FROM leads WHERE id = ?', [newLeadId]);
    createdNewLead = true;
  }

  const leadId = data.leadId || data.lead_id || lead?.id || null;
  if (!clientName && lead?.client_name) {
    clientName = lead.client_name;
  }
  if (!clientName) {
    clientName = clientPhone || 'WhatsApp Contact';
  }

  // Check if already exists by external_id
  const existing = externalId ? get('SELECT id FROM whatsapp_messages WHERE external_id = ?', [externalId]) : null;

  if (existing) {
    run(
      `UPDATE whatsapp_messages
       SET device_id = ?, lead_id = COALESCE(?, lead_id), executive_name = ?, client_name = ?,
           client_phone = ?, direction = ?, message = ?, timestamp = ?, status = ?
       WHERE id = ?`,
      [
        deviceId,
        leadId,
        executiveName,
        clientName,
        clientPhone,
        direction,
        message,
        timestamp,
        status,
        existing.id,
      ]
    );
  } else {
    run(
      `INSERT INTO whatsapp_messages
       (id, external_id, device_id, lead_id, executive_name, client_name, client_phone, direction, message, timestamp, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        externalId || id,
        deviceId,
        leadId,
        executiveName,
        clientName,
        clientPhone,
        direction,
        message,
        timestamp,
        status,
        new Date().toISOString(),
      ]
    );
  }

  // Update lead status and summary if it's an incoming message
  if (lead && direction === 'incoming' && message) {
    run(
      `UPDATE leads
       SET latest_summary = ?, hotness = 'hot'
       WHERE id = ?`,
      [`WhatsApp: ${message.slice(0, 100)}`, lead.id]
    );
  }

  // Sync to activities table for Lead 360 & unified feed
  const actId = `act-${id}`;
  const existingAct = get('SELECT id FROM activities WHERE id = ?', [actId]);
  const actTitle = direction === 'incoming'
    ? `💬 WhatsApp received from ${clientName}`
    : `📤 WhatsApp sent by ${executiveName}`;

  if (existingAct) {
    run(
      'UPDATE activities SET lead_id = COALESCE(?, lead_id), title = ?, detail = ?, created_at = ? WHERE id = ?',
      [leadId, actTitle, message, timestamp, actId]
    );
  } else {
    run(
      'INSERT INTO activities (id, lead_id, platform, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [actId, leadId, 'whatsapp', actTitle, message, timestamp]
    );
  }

  persistDb();

  return get('SELECT * FROM whatsapp_messages WHERE id = ?', [existing ? existing.id : id]);
}

export function purgeInvalidWhatsAppChannels() {
  try {
    const rows = all('SELECT id, lead_id, client_phone FROM whatsapp_messages');
    let removed = 0;
    for (const r of rows) {
      const digits = String(r.client_phone || '').replace(/\D/g, '');
      const isChannel = digits.length > 15 || digits.startsWith('120363');
      if (!isChannel) continue;
      run('DELETE FROM whatsapp_messages WHERE id = ?', [r.id]);
      run('DELETE FROM activities WHERE id = ?', [`act-${r.id}`]);
      if (r.lead_id && String(r.lead_id).startsWith('lead-wa-')) {
        run('DELETE FROM leads WHERE id = ?', [r.lead_id]);
      }
      removed += 1;
    }
    if (removed > 0) {
      console.log(`[WhatsApp DB] Auto-purged ${removed} channel/newsletter rows on boot.`);
      persistDb();
    }
    return removed;
  } catch (err) {
    console.warn('[WhatsApp DB] Notice in purgeInvalidWhatsAppChannels:', err.message);
    return 0;
  }
}

export function repairExistingWhatsAppLids() {
  try {
    const sessionsDir = path.resolve(backendRoot, './data/whatsapp-sessions');
    if (!fs.existsSync(sessionsDir)) return 0;

    // Build global LID -> +Phone lookup map from all Baileys session folders
    const lidMap = new Map();
    for (const dirName of fs.readdirSync(sessionsDir)) {
      const fullDir = path.join(sessionsDir, dirName);
      if (!fs.statSync(fullDir).isDirectory()) continue;
      for (const fileName of fs.readdirSync(fullDir)) {
        const match = fileName.match(/^lid-mapping-(\d+)_reverse\.json$/);
        if (!match) continue;
        const lidDigits = match[1];
        if (lidMap.has(lidDigits)) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(fullDir, fileName), 'utf8'));
          const phoneDigits = String(raw || '').replace(/\D/g, '');
          if (phoneDigits.length >= 10 && phoneDigits.length <= 15) {
            lidMap.set(lidDigits, `+${phoneDigits}`);
          }
        } catch {}
      }
    }

    if (lidMap.size === 0) return 0;

    let repaired = 0;
    const msgs = all('SELECT id, lead_id, client_name, client_phone FROM whatsapp_messages');
    for (const m of msgs) {
      const digits = String(m.client_phone || '').replace(/\D/g, '');
      const realPhone = lidMap.get(digits);
      if (!realPhone || realPhone === m.client_phone) continue;

      const updatedName = m.client_name === m.client_phone ? realPhone : m.client_name;
      run('UPDATE whatsapp_messages SET client_phone = ?, client_name = ? WHERE id = ?', [
        realPhone,
        updatedName,
        m.id,
      ]);
      if (m.lead_id) {
        const leadRow = get('SELECT id, client_name, client_phone FROM leads WHERE id = ?', [m.lead_id]);
        if (leadRow) {
          const newLeadName = leadRow.client_name === leadRow.client_phone ? realPhone : leadRow.client_name;
          run('UPDATE leads SET client_phone = ?, client_name = ? WHERE id = ?', [
            realPhone,
            newLeadName,
            leadRow.id,
          ]);
        }
      }
      repaired += 1;
    }

    if (repaired > 0) {
      console.log(`[WhatsApp DB] Repaired ${repaired} LID phone numbers to real +91/E.164 phone numbers.`);
      persistDb();
    }
    return repaired;
  } catch (err) {
    console.warn('[WhatsApp DB] Notice in repairExistingWhatsAppLids:', err.message);
    return 0;
  }
}

export function listWhatsAppMessages(filters = {}) {
  const conditions = ["length(replace(m.client_phone, '+', '')) <= 15", "m.client_phone NOT LIKE '+120363%'"];
  const params = [];

  if (filters.search) {
    conditions.push(
      '(m.client_name LIKE ? OR m.client_phone LIKE ? OR m.executive_name LIKE ? OR m.message LIKE ?)'
    );
    const term = `%${filters.search}%`;
    params.push(term, term, term, term);
  }

  if (filters.direction) {
    conditions.push('m.direction = ?');
    params.push(filters.direction.toLowerCase());
  }

  if (filters.executive) {
    conditions.push('m.executive_name LIKE ?');
    params.push(`%${filters.executive}%`);
  }

  if (filters.leadId) {
    conditions.push('m.lead_id = ?');
    params.push(filters.leadId);
  }

  if (filters.phone) {
    const digits = filters.phone.replace(/\D/g, '').slice(-10);
    conditions.push('m.client_phone LIKE ?');
    params.push(`%${digits}%`);
  }

  const limit = Number(filters.limit) || 100;
  params.push(limit);

  const query = `
    SELECT m.*, l.company, l.stage, l.hotness
    FROM whatsapp_messages m
    LEFT JOIN leads l ON m.lead_id = l.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.timestamp DESC
    LIMIT ?
  `;

  return all(query, params);
}

export function getWhatsAppStats() {
  const row = get(`
    SELECT
      COUNT(*) AS total_messages,
      SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) AS incoming_count,
      SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) AS outgoing_count,
      COUNT(DISTINCT client_phone) AS active_contacts,
      COUNT(DISTINCT executive_name) AS active_executives
    FROM whatsapp_messages
  `);

  const execRows = all(`
    SELECT executive_name, COUNT(*) AS message_count
    FROM whatsapp_messages
    GROUP BY executive_name
    ORDER BY message_count DESC
  `);

  return {
    total_messages: row?.total_messages ?? 0,
    incoming_count: row?.incoming_count ?? 0,
    outgoing_count: row?.outgoing_count ?? 0,
    active_contacts: row?.active_contacts ?? 0,
    active_executives: row?.active_executives ?? 0,
    by_executive: execRows,
  };
}

export function clearDummyWhatsAppMessages() {
  const dummyRows = all(
    `SELECT id FROM whatsapp_messages
     WHERE device_id = 'd-ambuj-1'
        OR external_id LIKE 'wa-msg-%'
        OR external_id LIKE 'sim-wa-%'`,
  );
  for (const row of dummyRows) {
    run('DELETE FROM whatsapp_messages WHERE id = ?', [row.id]);
    run('DELETE FROM activities WHERE id = ?', [`act-${row.id}`]);
  }
  persistDb();
  return dummyRows.length;
}

export function seedWhatsAppMessagesIfEmpty() {
  try {
    if (!shouldSeedSampleData && process.env.NODE_ENV !== 'test') {
      return;
    }
    const row = get('SELECT COUNT(*) AS count FROM whatsapp_messages');
    if ((row?.count ?? 0) === 0) {
      const sampleMessages = [
        {
          externalId: 'wa-msg-101',
          deviceId: 'd-ambuj-1',
          leadId: 'lead-1',
          executiveName: 'Ambuj Pathak',
          clientName: 'ABC Polymers',
          clientPhone: '+919215144541',
          direction: 'incoming',
          message: 'Sir kal tak quotation update karke share kar dijiye. Volume approx 50 MT per month hoga.',
          timestamp: '2026-11-17T11:45:00Z',
          status: 'received',
        },
        {
          externalId: 'wa-msg-102',
          deviceId: 'd-ambuj-1',
          leadId: 'lead-1',
          executiveName: 'Ambuj Pathak',
          clientName: 'ABC Polymers',
          clientPhone: '+919215144541',
          direction: 'outgoing',
          message: 'Ji sir, definitely. Main kal subah 11:00 AM tak revised quote with CPCB certificate bhej raha hoon.',
          timestamp: '2026-11-17T11:48:00Z',
          status: 'sent',
        },
        {
          externalId: 'wa-msg-103',
          deviceId: 'd-ambuj-1',
          leadId: 'lead-2',
          executiveName: 'Ambuj Pathak',
          clientName: 'Vardhman Plastics',
          clientPhone: '+919990689777',
          direction: 'incoming',
          message: 'Hamara Category II plastic waste ka certificate draft WhatsApp pe bhejo ek baar.',
          timestamp: '2026-11-17T15:20:00Z',
          status: 'received',
        },
        {
          externalId: 'wa-msg-104',
          deviceId: 'd-ambuj-1',
          leadId: 'lead-2',
          executiveName: 'Ambuj Pathak',
          clientName: 'Vardhman Plastics',
          clientPhone: '+919990689777',
          direction: 'outgoing',
          message: 'Shared specimen certificate PDF. Please review and confirm your quarterly targets.',
          timestamp: '2026-11-17T15:25:00Z',
          status: 'sent',
        },
      ];

      for (const msg of sampleMessages) {
        upsertWhatsAppMessage(msg);
      }
    }
  } catch (err) {
    console.warn('[WhatsApp DB] Notice in seedWhatsAppMessagesIfEmpty:', err.message);
  }
}

export function listExecutives() {
  return all(`
    SELECT u.id, u.name, u.email, u.role, d.employee_phone AS phone
    FROM users u
    LEFT JOIN devices d ON d.user_id = u.id
    ORDER BY u.rowid ASC
  `);
}

export function createExecutive({ name, email = '', phone = '', role = 'executive' } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    throw new Error('Executive name is required');
  }
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPhone = sanitizePhone(phone || '');

  if (cleanEmail) {
    const existing = get('SELECT id FROM users WHERE LOWER(email) = ?', [cleanEmail]);
    if (existing) {
      throw new Error('An executive with this email already exists');
    }
  }

  const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'exec';
  const id = `u-${slug}-${randomUUID().slice(0, 4)}`;

  run(
    'INSERT INTO users (id, name, email, role) VALUES (?, ?, ?, ?)',
    [id, cleanName, cleanEmail || `${slug}@climeto.com`, role || 'executive'],
  );

  if (cleanPhone) {
    run(
      'INSERT INTO devices (id, user_id, employee_name, employee_phone) VALUES (?, ?, ?, ?)',
      [`d-${slug}-${randomUUID().slice(0, 4)}`, id, cleanName, cleanPhone],
    );
  }

  persistDb();
  return get(
    `SELECT u.id, u.name, u.email, u.role, d.employee_phone AS phone
     FROM users u
     LEFT JOIN devices d ON d.user_id = u.id
     WHERE u.id = ?`,
    [id],
  );
}

export function deleteExecutive(id) {
  const existing = get('SELECT id FROM users WHERE id = ?', [id]);
  if (!existing) return false;
  run('DELETE FROM devices WHERE user_id = ?', [id]);
  run('DELETE FROM users WHERE id = ?', [id]);
  persistDb();
  return true;
}

/**
 * Syncs executive names from Supabase Calling directory (`users` table)
 * onto matching local executives (by last 10 digits of work SIM phone),
 * and aligns existing WhatsApp messages + pitch evaluations to those exact Calling names.
 */
export function syncExecutiveDirectoryFromCalling(callingUsers = []) {
  if (!Array.isArray(callingUsers) || callingUsers.length === 0) return { updated: 0 };

  let updated = 0;
  for (const cu of callingUsers) {
    const callingName = String(cu.name || '').trim();
    const rawDigits = String(cu.phone || '').replace(/\D/g, '');
    const last10 = rawDigits.length >= 10 ? rawDigits.slice(-10) : '';
    if (!callingName || !last10) continue;

    // 1. Update matching local devices & users by phone number
    const matchingDevices = all('SELECT id, user_id, employee_name FROM devices WHERE employee_phone LIKE ?', [
      `%${last10}`,
    ]);
    for (const dev of matchingDevices) {
      const oldName = dev.employee_name || '';
      if (dev.user_id) {
        const u = get('SELECT id, name FROM users WHERE id = ?', [dev.user_id]);
        if (u && u.name !== callingName) {
          run('UPDATE users SET name = ? WHERE id = ?', [callingName, u.id]);
          updated += 1;
        }
        run('UPDATE whatsapp_messages SET executive_name = ? WHERE device_id = ?', [
          callingName,
          `server-bridge-${dev.user_id}`,
        ]);
      }
      if (oldName !== callingName) {
        run('UPDATE devices SET employee_name = ? WHERE id = ?', [callingName, dev.id]);
        if (oldName) {
          run('UPDATE whatsapp_messages SET executive_name = ? WHERE LOWER(executive_name) = ?', [
            callingName,
            oldName.toLowerCase(),
          ]);
          run('UPDATE pitch_evaluations SET executive_name = ? WHERE LOWER(executive_name) = ?', [
            callingName,
            oldName.toLowerCase(),
          ]);
        }
      }
    }

    // 2. Also update any whatsapp_messages or pitch_evaluations stored with the raw phone number
    run('UPDATE whatsapp_messages SET executive_name = ? WHERE executive_name LIKE ?', [
      callingName,
      `%${last10}`,
    ]);
    run('UPDATE pitch_evaluations SET executive_name = ? WHERE executive_name LIKE ?', [
      callingName,
      `%${last10}`,
    ]);
  }

  if (updated > 0) {
    console.log(`[Executive Sync] Aligned ${updated} local executive name(s) with Calling directory.`);
  }
  persistDb();
  return { updated };
}

// ============================================================
// Pitch Training: Smart Playbook, Evaluations & AI Roleplay
// ============================================================

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function seedPlaybookIfEmpty() {
  try {
    const row = get('SELECT COUNT(*) AS count FROM playbook_rules');
    if ((row?.count ?? 0) > 0) return;

    const now = new Date().toISOString();
    const starterRules = [
      {
        id: 'pb-disc-1',
        category: 'discovery',
        title: 'Confirm PIBO Entity Type',
        client_cue: 'Early discovery on call or WhatsApp',
        ideal_response: 'Sir, aapki company CPCB portal par Producer, Importer, ya Brand Owner (PIBO) ke roop me registered hai?',
        priority: 1,
      },
      {
        id: 'pb-disc-2',
        category: 'discovery',
        title: 'Ask Plastic Waste Category (I / II / III)',
        client_cue: 'Before sharing any commercial quotation',
        ideal_response: 'Aapka plastic packaging kis category me aata hai — Category I (Rigid), Category II (Flexible), ya Category III (Multi-layered/MLP)?',
        priority: 1,
      },
      {
        id: 'pb-disc-3',
        category: 'discovery',
        title: 'Ask Annual / Monthly Volume (MT)',
        client_cue: 'Before quoting per-MT credit rate',
        ideal_response: 'Aapka annual EPR target approx kitne Metric Tons (MT) ka hai? Exact volume ke hisaab se best commercial slab share kar paunga.',
        priority: 1,
      },
      {
        id: 'pb-disc-4',
        category: 'discovery',
        title: 'Check Current Vendor & Filing Timeline',
        client_cue: 'Qualifying urgency and competition',
        ideal_response: 'Abhi aap EPR credits aur filing internally handle kar rahe hain ya kisi existing vendor ke through? Is quarter ki filing kab tak target kar rahe hain?',
        priority: 2,
      },
      {
        id: 'pb-obj-1',
        category: 'objection',
        title: 'Price Too High / Competitor Is Cheaper',
        client_cue: '"Rate zyada hai" / "Doosra vendor sasta de raha hai"',
        ideal_response: 'Sir, saste credits me aksar CPCB audit ya invalid recycler certificate ka risk hota hai. Climeto aapko 100% CPCB-verified credits aur end-to-end filing support deta hai — aapka exact MT volume batayein to main best slab share karta hoon.',
        priority: 1,
      },
      {
        id: 'pb-obj-2',
        category: 'objection',
        title: 'Client Is Busy / Call Later',
        client_cue: '"Abhi time nahi hai" / "Baad me call karo"',
        ideal_response: 'Bilkul sir, bas 20 second lunga — aapka annual EPR target approx kitne MT ka hai? Main WhatsApp par 3-point summary bhej deta hoon, kal subah 11 baje connect kar lein?',
        priority: 1,
      },
      {
        id: 'pb-obj-3',
        category: 'objection',
        title: 'Send Details on WhatsApp / Email',
        client_cue: '"Details WhatsApp / mail par bhej do"',
        ideal_response: 'Zaroor sir, main abhi brochure aur rough slab WhatsApp kar raha hoon. Accurate quotation ke liye bas apni waste category aur approx MT confirm kar dijiye — kal 11:30 AM par 2-minute review call rakhein?',
        priority: 1,
      },
      {
        id: 'pb-obj-4',
        category: 'objection',
        title: 'Already Working With Another Vendor',
        client_cue: '"Hamara existing vendor already hai"',
        ideal_response: 'Great sir, agar current vendor acha kaam kar raha hai to badhiya hai. Bahut se PIBO clients humein secondary partner rakhte hain taaki deadline par credit shortage ya rate hike na ho — ek comparison quote bhej doon?',
        priority: 2,
      },
      {
        id: 'pb-wa-1',
        category: 'whatsapp_template',
        title: 'Post-Call Quotation & Brochure Follow-Up',
        client_cue: 'Immediately after client asks for quotation on call',
        ideal_response: 'Hello [Client Name] ji, thank you for speaking with Climeto. Sharing our EPR Plastic Credits brochure & CPCB compliance overview. Please share your Category (I/II/III) & approx annual MT target so I can send the best commercial quote today.',
        priority: 1,
      },
      {
        id: 'pb-rf-1',
        category: 'red_flag',
        title: 'Quoting Blindly Without Volume or Category',
        client_cue: 'Executive quotes a flat rate without asking Category I/II/III or MT volume',
        ideal_response: 'Never quote blind flat rates or unapproved discounts before confirming waste category and annual MT volume.',
        priority: 1,
      },
      {
        id: 'pb-rf-2',
        category: 'red_flag',
        title: 'Broken Follow-Up Promise',
        client_cue: 'Executive promises quotation/brochure on call but does not send WhatsApp/Email same day',
        ideal_response: 'Every document or quotation promised on a call must be sent on WhatsApp/Email within the committed window.',
        priority: 1,
      },
    ];

    for (const rule of starterRules) {
      run(
        `INSERT INTO playbook_rules
         (id, category, title, client_cue, ideal_response, priority, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [rule.id, rule.category, rule.title, rule.client_cue, rule.ideal_response, rule.priority, now, now],
      );
    }
    persistDb();
  } catch (err) {
    console.warn('[Playbook DB] Notice in seedPlaybookIfEmpty:', err.message);
  }
}

export function listPlaybookRules({ category = '', activeOnly = false } = {}) {
  const conditions = ['1=1'];
  const params = [];
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (activeOnly) {
    conditions.push('is_active = 1');
  }
  return all(
    `SELECT * FROM playbook_rules WHERE ${conditions.join(' AND ')} ORDER BY priority ASC, created_at ASC`,
    params,
  );
}

export function upsertPlaybookRule(data = {}) {
  const category = String(data.category || 'objection').trim().toLowerCase();
  const title = String(data.title || '').trim();
  const clientCue = String(data.client_cue || data.clientCue || '').trim();
  const idealResponse = String(data.ideal_response || data.idealResponse || '').trim();
  const priority = Number(data.priority || 1);
  const isActive = data.is_active === false || data.is_active === 0 ? 0 : 1;

  if (!title) throw new Error('Playbook rule title is required');
  if (!idealResponse) throw new Error('Ideal response / guidance is required');

  const now = new Date().toISOString();
  const existingId = data.id ? get('SELECT id FROM playbook_rules WHERE id = ?', [data.id]) : null;

  if (existingId) {
    run(
      `UPDATE playbook_rules
       SET category = ?, title = ?, client_cue = ?, ideal_response = ?, priority = ?, is_active = ?, updated_at = ?
       WHERE id = ?`,
      [category, title, clientCue, idealResponse, priority, isActive, now, existingId.id],
    );
    persistDb();
    return get('SELECT * FROM playbook_rules WHERE id = ?', [existingId.id]);
  }

  const id = `pb-${category.slice(0, 4)}-${randomUUID().slice(0, 6)}`;
  run(
    `INSERT INTO playbook_rules
     (id, category, title, client_cue, ideal_response, priority, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, category, title, clientCue, idealResponse, priority, isActive, now, now],
  );
  persistDb();
  return get('SELECT * FROM playbook_rules WHERE id = ?', [id]);
}

export function deletePlaybookRule(id) {
  const existing = get('SELECT id FROM playbook_rules WHERE id = ?', [id]);
  if (!existing) return false;
  run('DELETE FROM playbook_rules WHERE id = ?', [id]);
  persistDb();
  return true;
}

function parsePitchEvaluation(row) {
  if (!row) return null;
  return {
    ...row,
    scores: safeJsonParse(row.scores_json, {}),
    strengths: safeJsonParse(row.strengths_json, []),
    gaps: safeJsonParse(row.gaps_json, []),
    missed_questions: safeJsonParse(row.missed_questions_json, []),
    red_flags: safeJsonParse(row.red_flags_json, []),
  };
}

export function upsertPitchEvaluation(data = {}) {
  const targetType = String(data.target_type || data.targetType || 'call').trim();
  const targetId = String(data.target_id || data.targetId || '').trim();
  if (!targetId) throw new Error('target_id is required');

  const now = new Date().toISOString();
  const existing = get(
    'SELECT id, manager_status, manager_score, manager_note, manager_try_line FROM pitch_evaluations WHERE target_type = ? AND target_id = ?',
    [targetType, targetId],
  );

  const scoresJson = JSON.stringify(data.scores || {});
  const strengthsJson = JSON.stringify(data.strengths || []);
  const gapsJson = JSON.stringify(data.gaps || []);
  const missedJson = JSON.stringify(data.missed_questions || data.missedQuestions || []);
  const redFlagsJson = JSON.stringify(data.red_flags || data.redFlags || []);
  const overallScore = Number(data.overall_score ?? data.overallScore ?? 0);

  if (existing) {
    run(
      `UPDATE pitch_evaluations
       SET lead_id = COALESCE(?, lead_id),
           executive_name = ?,
           client_name = ?,
           channel_summary = ?,
           overall_score = ?,
           scores_json = ?,
           strengths_json = ?,
           gaps_json = ?,
           missed_questions_json = ?,
           red_flags_json = ?,
           try_line = ?,
           ai_summary = ?,
           model_used = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        data.lead_id || data.leadId || null,
        String(data.executive_name || data.executiveName || 'Sales Executive'),
        String(data.client_name || data.clientName || 'Client'),
        String(data.channel_summary || data.channelSummary || ''),
        overallScore,
        scoresJson,
        strengthsJson,
        gapsJson,
        missedJson,
        redFlagsJson,
        String(data.try_line || data.tryLine || ''),
        String(data.ai_summary || data.aiSummary || ''),
        String(data.model_used || data.modelUsed || 'gemini'),
        now,
        existing.id,
      ],
    );
    persistDb();
    return parsePitchEvaluation(get('SELECT * FROM pitch_evaluations WHERE id = ?', [existing.id]));
  }

  const id = `pe-${randomUUID().slice(0, 8)}`;
  run(
    `INSERT INTO pitch_evaluations
     (id, target_type, target_id, lead_id, executive_name, client_name, channel_summary, overall_score,
      scores_json, strengths_json, gaps_json, missed_questions_json, red_flags_json,
      try_line, ai_summary, model_used, manager_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      targetType,
      targetId,
      data.lead_id || data.leadId || null,
      String(data.executive_name || data.executiveName || 'Sales Executive'),
      String(data.client_name || data.clientName || 'Client'),
      String(data.channel_summary || data.channelSummary || ''),
      overallScore,
      scoresJson,
      strengthsJson,
      gapsJson,
      missedJson,
      redFlagsJson,
      String(data.try_line || data.tryLine || ''),
      String(data.ai_summary || data.aiSummary || ''),
      String(data.model_used || data.modelUsed || 'gemini'),
      now,
      now,
    ],
  );
  persistDb();
  return parsePitchEvaluation(get('SELECT * FROM pitch_evaluations WHERE id = ?', [id]));
}

export function listPitchEvaluations({ executive = '', managerStatus = '', targetType = '', limit = 50 } = {}) {
  const conditions = ['1=1'];
  const params = [];
  if (executive) {
    conditions.push('executive_name LIKE ?');
    params.push(`%${executive}%`);
  }
  if (managerStatus) {
    conditions.push('manager_status = ?');
    params.push(managerStatus);
  }
  if (targetType) {
    conditions.push('target_type = ?');
    params.push(targetType);
  }
  params.push(Number(limit) || 50);

  return all(
    `SELECT * FROM pitch_evaluations WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
    params,
  ).map(parsePitchEvaluation);
}

export function getPitchEvaluationById(id) {
  return parsePitchEvaluation(get('SELECT * FROM pitch_evaluations WHERE id = ?', [id]));
}

export function updatePitchEvaluationFeedback(id, { managerStatus = 'approved', managerScore = null, managerNote = '', managerTryLine = '' } = {}) {
  const existing = get('SELECT * FROM pitch_evaluations WHERE id = ?', [id]);
  if (!existing) return null;

  const now = new Date().toISOString();
  run(
    `UPDATE pitch_evaluations
     SET manager_status = ?,
         manager_score = COALESCE(?, manager_score),
         manager_note = ?,
         manager_try_line = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      String(managerStatus || 'approved'),
      managerScore != null && managerScore !== '' ? Number(managerScore) : null,
      String(managerNote || ''),
      String(managerTryLine || ''),
      now,
      id,
    ],
  );
  persistDb();
  return getPitchEvaluationById(id);
}

export function resolveUnifiedExecutive(identifier = '') {
  const raw = String(identifier || '').trim();
  if (!raw) {
    return { canonicalName: 'Sales Executive', userId: null, email: '', phone: '' };
  }

  const execs = listExecutives();
  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : '';

  for (const ex of execs) {
    const exName = String(ex.name || '').trim();
    const exEmail = String(ex.email || '').trim().toLowerCase();
    const exDigits = String(ex.phone || '').replace(/\D/g, '');
    const exLast10 = exDigits.length >= 10 ? exDigits.slice(-10) : '';

    if (
      ex.id === raw ||
      (exName && exName.toLowerCase() === lower) ||
      (exEmail && exEmail === lower) ||
      (last10 && exLast10 && last10 === exLast10)
    ) {
      return {
        canonicalName: exName || raw,
        userId: ex.id,
        email: ex.email || '',
        phone: ex.phone || '',
      };
    }
  }

  return {
    canonicalName: raw,
    userId: null,
    email: raw.includes('@') ? lower : '',
    phone: last10 ? raw : '',
  };
}

function getExecutiveChannelCounts({ canonicalName, userId, email, phone }) {
  const nameLike = `%${canonicalName}%`;
  const digits10 = String(phone || '').replace(/\D/g, '').slice(-10);
  const phoneLike = digits10.length === 10 ? `%${digits10}` : '';

  const callRows = all(
    'SELECT id, lead_id FROM calls WHERE executive_name LIKE ? OR (? != "" AND user_id = ?)',
    [nameLike, userId || '', userId || ''],
  );

  const waRows = all(
    `SELECT id, lead_id FROM whatsapp_messages
     WHERE (executive_name LIKE ? OR (? != "" AND executive_name LIKE ?))
       AND length(replace(client_phone, '+', '')) <= 15
       AND client_phone NOT LIKE '+120363%'`,
    [nameLike, phoneLike, phoneLike],
  );

  const emailRows = all(
    'SELECT id, lead_id FROM zoho_emails WHERE executive_name LIKE ? OR (? != "" AND LOWER(executive_email) = ?)',
    [nameLike, email || '', String(email || '').toLowerCase()],
  );

  const leadIds = new Set();
  for (const r of [...callRows, ...waRows, ...emailRows]) {
    if (r.lead_id) leadIds.add(r.lead_id);
  }
  if (userId) {
    for (const l of all('SELECT id FROM leads WHERE owner_id = ?', [userId])) {
      leadIds.add(l.id);
    }
  }

  let campaignCount = 0;
  if (leadIds.size > 0) {
    const ids = Array.from(leadIds);
    const placeholders = ids.map(() => '?').join(',');
    const cRow = get(`SELECT COUNT(*) AS cnt FROM campaign_events WHERE lead_id IN (${placeholders})`, ids);
    campaignCount = cRow?.cnt ?? 0;
  }

  const zohoAcctRow = get('SELECT COUNT(*) AS cnt FROM zoho_accounts WHERE owner_name LIKE ?', [nameLike]);

  return {
    calls: callRows.length,
    whatsapp: waRows.length,
    zoho_emails: emailRows.length,
    campaigns: campaignCount,
    leads: leadIds.size,
    zoho_accounts: zohoAcctRow?.cnt ?? 0,
  };
}

export function getCallTrainingCoverage() {
  const totalCallsRow = get('SELECT COUNT(*) AS cnt FROM calls');
  const evaluatedCallsRow = get(
    "SELECT COUNT(DISTINCT target_id) AS cnt FROM pitch_evaluations WHERE target_type = 'call'",
  );
  const totalCalls = totalCallsRow?.cnt ?? 0;
  const evaluatedCalls = evaluatedCallsRow?.cnt ?? 0;
  return {
    total_calls_synced: totalCalls,
    calls_evaluated: evaluatedCalls,
    calls_pending: Math.max(totalCalls - evaluatedCalls, 0),
  };
}

export function getExecutiveCoachingSummary() {
  const evaluations = listPitchEvaluations({ limit: 1000 });
  const byExec = new Map();

  for (const ev of evaluations) {
    const resolved = resolveUnifiedExecutive(ev.executive_name || 'Sales Executive');
    const key = resolved.canonicalName;
    if (!byExec.has(key)) {
      byExec.set(key, {
        executive_name: key,
        user_id: resolved.userId,
        email: resolved.email,
        phone: resolved.phone,
        evaluated_count: 0,
        approved_count: 0,
        total_score: 0,
        pillar_totals: { opener: 0, discovery: 0, value_pitch: 0, objection_handling: 0, closing: 0, followup: 0 },
        pillar_counts: { opener: 0, discovery: 0, value_pitch: 0, objection_handling: 0, closing: 0, followup: 0 },
        gap_counts: new Map(),
        red_flag_count: 0,
      });
    }
    const bucket = byExec.get(key);
    bucket.evaluated_count += 1;
    if (ev.manager_status === 'approved' || ev.manager_status === 'edited') {
      bucket.approved_count += 1;
    }
    const effectiveScore = ev.manager_score != null ? Number(ev.manager_score) : Number(ev.overall_score || 0);
    bucket.total_score += effectiveScore;
    bucket.red_flag_count += (ev.red_flags || []).length;

    for (const pillar of Object.keys(bucket.pillar_totals)) {
      const val = Number(ev.scores?.[pillar]);
      if (!Number.isNaN(val) && val > 0) {
        bucket.pillar_totals[pillar] += val;
        bucket.pillar_counts[pillar] += 1;
      }
    }
    for (const gap of ev.gaps || []) {
      const g = String(gap).trim();
      if (g) bucket.gap_counts.set(g, (bucket.gap_counts.get(g) || 0) + 1);
    }
  }

  const executives = Array.from(byExec.values()).map((b) => {
    const pillars = {};
    for (const p of Object.keys(b.pillar_totals)) {
      pillars[p] = b.pillar_counts[p] > 0 ? Number((b.pillar_totals[p] / b.pillar_counts[p]).toFixed(1)) : 0;
    }
    const topGaps = Array.from(b.gap_counts.entries())
      .sort((a, c) => c[1] - a[1])
      .slice(0, 3)
      .map(([text]) => text);

    const channels = getExecutiveChannelCounts({
      canonicalName: b.executive_name,
      userId: b.user_id,
      email: b.email,
      phone: b.phone,
    });

    return {
      executive_name: b.executive_name,
      email: b.email,
      phone: b.phone,
      evaluated_count: b.evaluated_count,
      approved_count: b.approved_count,
      avg_score: b.evaluated_count > 0 ? Number((b.total_score / b.evaluated_count).toFixed(1)) : 0,
      red_flag_count: b.red_flag_count,
      pillars,
      channels,
      top_gaps: topGaps,
    };
  });

  const approvedTotal = evaluations.filter((e) => e.manager_status === 'approved' || e.manager_status === 'edited').length;
  const avgOverall =
    evaluations.length > 0
      ? Number(
          (
            evaluations.reduce((sum, e) => sum + Number(e.manager_score ?? e.overall_score ?? 0), 0) /
            evaluations.length
          ).toFixed(1),
        )
      : 0;

  return {
    stats: {
      total_evaluated: evaluations.length,
      manager_approved: approvedTotal,
      fine_tune_target: 200,
      avg_score: avgOverall,
      playbook_rules: listPlaybookRules({ activeOnly: true }).length,
      winning_pitches: evaluations.filter((e) => Number(e.manager_score ?? e.overall_score ?? 0) >= 8).length,
    },
    call_coverage: getCallTrainingCoverage(),
    executives: executives.sort((a, b) => b.avg_score - a.avg_score),
    evaluations,
  };
}

export function exportTrainingJsonl() {
  const approved = listPitchEvaluations({ limit: 2000 }).filter(
    (e) => e.manager_status === 'approved' || e.manager_status === 'edited',
  );

  return approved
    .map((ev) => {
      const targetOutput = {
        overall_score: ev.manager_score ?? ev.overall_score,
        scores: ev.scores,
        strengths: ev.strengths,
        gaps: ev.gaps,
        missed_questions: ev.missed_questions,
        red_flags: ev.red_flags,
        try_line: ev.manager_try_line || ev.try_line,
        summary: ev.ai_summary,
      };
      return JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Evaluate this Climeto EPR sales interaction for ${ev.executive_name} with ${ev.client_name}:\n${ev.channel_summary}`,
              },
            ],
          },
          {
            role: 'model',
            parts: [{ text: JSON.stringify(targetOutput) }],
          },
        ],
      });
    })
    .join('\n');
}

function parseRoleplay(row) {
  if (!row) return null;
  return {
    ...row,
    messages: safeJsonParse(row.messages_json, []),
    score: safeJsonParse(row.score_json, null),
  };
}

export function createRoleplaySession({ executiveName, scenarioId, scenarioTitle, personaPrompt, openingMessage }) {
  const id = `rp-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const messages = [
    {
      role: 'prospect',
      text: openingMessage,
      timestamp: now,
    },
  ];
  run(
    `INSERT INTO roleplay_sessions
     (id, executive_name, scenario_id, scenario_title, persona_prompt, messages_json, score_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)`,
    [id, executiveName || 'Sales Executive', scenarioId, scenarioTitle, personaPrompt, JSON.stringify(messages), now, now],
  );
  persistDb();
  return parseRoleplay(get('SELECT * FROM roleplay_sessions WHERE id = ?', [id]));
}

export function getRoleplaySessionById(id) {
  return parseRoleplay(get('SELECT * FROM roleplay_sessions WHERE id = ?', [id]));
}

export function listRoleplaySessions({ executive = '', limit = 20 } = {}) {
  if (executive) {
    return all(
      'SELECT * FROM roleplay_sessions WHERE executive_name LIKE ? ORDER BY updated_at DESC LIMIT ?',
      [`%${executive}%`, Number(limit) || 20],
    ).map(parseRoleplay);
  }
  return all('SELECT * FROM roleplay_sessions ORDER BY updated_at DESC LIMIT ?', [Number(limit) || 20]).map(
    parseRoleplay,
  );
}

export function updateRoleplaySession(id, { messages, score, status }) {
  const existing = get('SELECT * FROM roleplay_sessions WHERE id = ?', [id]);
  if (!existing) return null;
  const now = new Date().toISOString();
  run(
    `UPDATE roleplay_sessions
     SET messages_json = COALESCE(?, messages_json),
         score_json = COALESCE(?, score_json),
         status = COALESCE(?, status),
         updated_at = ?
     WHERE id = ?`,
    [
      messages ? JSON.stringify(messages) : null,
      score ? JSON.stringify(score) : null,
      status || null,
      now,
      id,
    ],
  );
  persistDb();
  return getRoleplaySessionById(id);
}

// ============================================================
// EPR Knowledge Base Documents
// ============================================================

export function listKnowledgeDocs({ activeOnly = false } = {}) {
  const query = activeOnly
    ? 'SELECT id, filename, file_type, source_zip, title, content, summary, char_count, is_active, created_at, updated_at FROM knowledge_docs WHERE is_active = 1 ORDER BY updated_at DESC'
    : 'SELECT id, filename, file_type, source_zip, title, summary, char_count, is_active, created_at, updated_at FROM knowledge_docs ORDER BY updated_at DESC';
  return all(query);
}

export function getKnowledgeDocById(id) {
  return get('SELECT * FROM knowledge_docs WHERE id = ?', [id]);
}

export function upsertKnowledgeDoc({ filename, fileType = 'txt', sourceZip = '', title = '', content = '', summary = '' }) {
  const cleanFilename = String(filename || 'document.txt').trim();
  const cleanContent = String(content || '').trim();
  if (!cleanContent) {
    throw new Error(`No readable text found in ${cleanFilename}`);
  }

  const cleanTitle =
    String(title || '').trim() ||
    cleanFilename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const cleanSummary =
    String(summary || '').trim() || cleanContent.replace(/\s+/g, ' ').slice(0, 220);
  const now = new Date().toISOString();

  const existing = get(
    'SELECT id FROM knowledge_docs WHERE filename = ? AND COALESCE(source_zip, ?) = ?',
    [cleanFilename, '', String(sourceZip || '')],
  );

  if (existing) {
    run(
      `UPDATE knowledge_docs
       SET file_type = ?, title = ?, content = ?, summary = ?, char_count = ?, is_active = 1, updated_at = ?
       WHERE id = ?`,
      [fileType, cleanTitle, cleanContent, cleanSummary, cleanContent.length, now, existing.id],
    );
    persistDb();
    return get('SELECT * FROM knowledge_docs WHERE id = ?', [existing.id]);
  }

  const id = `kb-${randomUUID().slice(0, 8)}`;
  run(
    `INSERT INTO knowledge_docs
     (id, filename, file_type, source_zip, title, content, summary, char_count, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, cleanFilename, fileType, String(sourceZip || ''), cleanTitle, cleanContent, cleanSummary, cleanContent.length, now, now],
  );
  persistDb();
  return get('SELECT * FROM knowledge_docs WHERE id = ?', [id]);
}

export function toggleKnowledgeDoc(id, isActive) {
  const existing = get('SELECT id FROM knowledge_docs WHERE id = ?', [id]);
  if (!existing) return null;
  run('UPDATE knowledge_docs SET is_active = ?, updated_at = ? WHERE id = ?', [
    isActive ? 1 : 0,
    new Date().toISOString(),
    id,
  ]);
  persistDb();
  return get('SELECT id, filename, file_type, source_zip, title, summary, char_count, is_active, created_at, updated_at FROM knowledge_docs WHERE id = ?', [id]);
}

export function deleteKnowledgeDoc(id) {
  const existing = get('SELECT id FROM knowledge_docs WHERE id = ?', [id]);
  if (!existing) return false;
  run('DELETE FROM knowledge_docs WHERE id = ?', [id]);
  persistDb();
  return true;
}



