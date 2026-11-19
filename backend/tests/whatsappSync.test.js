import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-whatsapp.db');

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const { initializeDb, listActivities, listLeads, listWhatsAppMessages, upsertWhatsAppMessage } = await import(
  '../src/db.js'
);
const { createApp } = await import('../src/createApp.js');

let server;
let baseUrl;
const eventsEmitted = [];

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}${urlPath}`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      })
      .on('error', reject);
  });
}

function post(urlPath, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${urlPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

before(async () => {
  await initializeDb();
  const fakeSendEvent = (type, payload) => {
    eventsEmitted.push({ type, payload });
  };
  const app = createApp({ sendEvent: fakeSendEvent });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

describe('WhatsApp Android Sync API & DB', () => {
  test('GET /api/whatsapp/messages returns seeded messages and stats', async () => {
    const res = await get('/api/whatsapp/messages');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.messages));
    assert.ok(res.body.data.messages.length >= 1);
    assert.ok(res.body.data.stats);
    assert.ok(res.body.data.stats.total_messages >= 1);
  });

  test('Filtering WhatsApp messages by direction and search works', async () => {
    const resIn = await get('/api/whatsapp/messages?direction=incoming');
    assert.equal(resIn.status, 200);
    for (const msg of resIn.body.data.messages) {
      assert.equal(msg.direction, 'incoming');
    }

    const resSearch = await get('/api/whatsapp/messages?search=CPCB');
    assert.equal(resSearch.status, 200);
    assert.ok(resSearch.body.data.messages.length >= 1);
  });

  test('POST /api/whatsapp/sync ingests incoming WhatsApp from Android device and matches lead', async () => {
    const payload = {
      externalId: 'test-wa-android-001',
      deviceId: 'd-ambuj-1',
      executiveName: 'Ambuj Pathak',
      clientPhone: '9215144541', // matched without +91
      clientName: 'ABC Polymers',
      direction: 'incoming',
      message: 'Urgent: revised quotation needed before our board meeting.',
      timestamp: new Date().toISOString(),
    };

    const res = await post('/api/whatsapp/sync', payload);
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.lead_id, 'lead-1');
    assert.equal(res.body.data.direction, 'incoming');

    // Check SSE event was emitted
    const lastEvent = eventsEmitted[eventsEmitted.length - 1];
    assert.equal(lastEvent?.type, 'whatsapp.received');
    assert.equal(lastEvent?.payload?.client_name, 'ABC Polymers');

    // Check activities table logged it
    const activities = listActivities({ platform: 'whatsapp' });
    const matchedAct = activities.find((a) => a.detail && a.detail.includes('board meeting'));
    assert.ok(matchedAct);
    assert.equal(matchedAct.lead_id, 'lead-1');
  });

  test('POST /api/dev/simulate-whatsapp simulates interaction cleanly', async () => {
    const res = await post('/api/dev/simulate-whatsapp', {});
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.id);
    assert.ok(res.body.data.message);
  });

  test('POST /api/whatsapp/sync auto-creates a new lead for brand-new WhatsApp-first client', async () => {
    const payload = {
      externalId: 'test-wa-new-client-001',
      deviceId: 'server-bridge-u-ambuj',
      executiveName: 'Ambuj Pathak',
      clientPhone: '+919876543210',
      clientName: 'Apex Recyclers',
      direction: 'incoming',
      message: 'Hi, hume EPR plastic waste credits chahiye, quotation bhejiye.',
      timestamp: new Date().toISOString(),
    };

    const res = await post('/api/whatsapp/sync', payload);
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.lead_id, 'Should auto-create and attach a new lead_id');
    assert.ok(res.body.data.lead_id.startsWith('lead-wa-'));

    const allLeads = listLeads();
    const createdLead = allLeads.find((l) => l.id === res.body.data.lead_id);
    assert.ok(createdLead, 'New lead should exist in leads table');
    assert.equal(createdLead.client_name, 'Apex Recyclers');
    assert.equal(createdLead.client_phone, '+919876543210');
    assert.equal(createdLead.hotness, 'hot');
  });

  test('POST /api/whatsapp/sync rejects missing phone with 400', async () => {
    const res = await post('/api/whatsapp/sync', { clientPhone: '' });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });
});
