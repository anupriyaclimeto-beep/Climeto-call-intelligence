import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-manyreach.db');

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;
process.env.MANYREACH_WEBHOOK_SECRET = 'test-secret-xyz';
process.env.SHOW_SEEDED_CAMPAIGNS = 'false';
process.env.CORS_ORIGIN = 'http://localhost:5173';

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const { initializeDb, listCampaignFeed, resetManyreachTestData } = await import('../src/db.js');
const { createApp } = await import('../src/createApp.js');
const { normalizeManyreachEvent } = await import('../src/services/manyreachMapper.js');

let server;
let baseUrl;

function request(method, urlPath, { token, body, rawBody, headers } = {}) {
  const query = token != null ? `?token=${encodeURIComponent(token)}` : '';
  const payload = rawBody != null ? rawBody : body != null ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${urlPath}${query}`,
      {
        method,
        headers: {
          ...(payload != null
            ? {
                'Content-Type': headers?.['Content-Type'] || 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode, body: json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

before(async () => {
  await initializeDb();
  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

describe('normalizeManyreachEvent', () => {
  test('maps reply / click / open aliases', () => {
    assert.equal(normalizeManyreachEvent({ type: 'reply', email: 'a@b.com' }).eventType, 'replied');
    assert.equal(normalizeManyreachEvent({ event: 'click', email: 'a@b.com' }).eventType, 'clicked');
    assert.equal(normalizeManyreachEvent({ event_type: 'opened', email: 'a@b.com' }).eventType, 'opened');
  });
});

describe('Manyreach webhook + feed', () => {
  test('rejects wrong token with 401', async () => {
    const res = await request('POST', '/api/webhooks/manyreach', {
      token: 'wrong',
      body: { event_type: 'opened', email: 'procurement@abcpolymers.in' },
    });
    assert.equal(res.status, 401);
  });

  test('accepts valid token and matched lead appears in feed', async () => {
    resetManyreachTestData();
    const res = await request('POST', '/api/webhooks/manyreach', {
      token: 'test-secret-xyz',
      body: {
        id: 'evt-valid-1',
        event_type: 'replied',
        email: '  Procurement@ABCPolymers.in ',
        campaign_name: 'EPR Pricing Sequence',
        timestamp: '2026-11-16T10:00:00Z',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.inserted, true);

    const feed = await request('GET', '/api/campaigns/feed?limit=20');
    assert.equal(feed.status, 200);
    assert.ok(feed.body.data.some((item) => item.event_type === 'replied'));
    const matched = feed.body.data.find((item) => item.email === 'procurement@abcpolymers.in');
    assert.ok(matched);
    assert.equal(matched.lead_name, 'ABC Polymers');
    assert.equal(matched.phone, '+919215144541');
    assert.equal(feed.body.meta.live, true);
  });

  test('duplicate external_id is ignored', async () => {
    resetManyreachTestData();
    const payload = {
      id: 'evt-dup-1',
      event_type: 'opened',
      email: 'procurement@abcpolymers.in',
      timestamp: '2026-11-16T11:00:00Z',
    };

    const first = await request('POST', '/api/webhooks/manyreach', {
      token: 'test-secret-xyz',
      body: payload,
    });
    const second = await request('POST', '/api/webhooks/manyreach', {
      token: 'test-secret-xyz',
      body: payload,
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.data.inserted, true);
    assert.equal(second.status, 200);
    assert.equal(second.body.data.duplicate, true);

    const feed = listCampaignFeed({ limit: 50 });
    const opens = feed.items.filter((item) => item.event_type === 'opened' && item.email === 'procurement@abcpolymers.in');
    assert.equal(opens.length, 1);
  });

  test('unmatched lead still saves with null lead_id', async () => {
    resetManyreachTestData();
    const res = await request('POST', '/api/webhooks/manyreach', {
      token: 'test-secret-xyz',
      body: {
        id: 'evt-unmatched-1',
        event_type: 'clicked',
        email: 'nobody-in-crm@example.com',
        url: 'https://example.com/brochure',
        timestamp: '2026-11-16T12:00:00Z',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.inserted, true);

    const feed = listCampaignFeed({ limit: 50 });
    const row = feed.items.find((item) => item.email === 'nobody-in-crm@example.com');
    assert.ok(row);
    assert.equal(row.lead_id, null);
    assert.match(row.description, /Clicked URL/);
  });

  test('malformed JSON does not crash and returns 200', async () => {
    const res = await request('POST', '/api/webhooks/manyreach', {
      token: 'test-secret-xyz',
      rawBody: '{not-json',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  test('seeded rows hidden when SHOW_SEEDED_CAMPAIGNS=false', () => {
    const feed = listCampaignFeed({ limit: 50 });
    assert.ok(feed.items.every((item) => Number(item.is_seeded) === 0));
  });

  test('debug endpoint returns latest raw payload', async () => {
    resetManyreachTestData();
    await request('POST', '/api/webhooks/manyreach', {
      token: 'test-secret-xyz',
      body: {
        id: 'evt-debug-1',
        event_type: 'bounced',
        email: 'info@vardhmanplastics.in',
      },
    });

    const res = await request('GET', '/api/webhooks/manyreach/debug', {
      token: 'test-secret-xyz',
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.latest);
    assert.equal(res.body.data.latest.payload.id, 'evt-debug-1');
  });
});
