import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-whatsapp-bridge.db');

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const { initializeDb } = await import('../src/db.js');
const { createApp } = await import('../src/createApp.js');
const { getWhatsAppSessionsStatus } = await import('../src/services/whatsappBridge.js');

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

function post(urlPath, body = {}) {
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

describe('WhatsApp Multi-Device Bridge API & Sessions', () => {
  test('GET /api/whatsapp/sessions returns executives list and session state', async () => {
    const res = await get('/api/whatsapp/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 1);

    const ambuj = res.body.data.find((e) => e.executiveName.includes('Ambuj') || e.executiveId === 'u-ambuj');
    assert.ok(ambuj);
    assert.ok('status' in ambuj);
  });

  test('POST /api/whatsapp/sessions/:executiveId/disconnect handles clean reset', async () => {
    const res = await post('/api/whatsapp/sessions/u-ambuj/disconnect');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, 'disconnected');
  });

  test('Direct getWhatsAppSessionsStatus function returns array with metadata', () => {
    const sessions = getWhatsAppSessionsStatus();
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length >= 1);
  });

  test('POST /api/executives adds a new executive that appears in WhatsApp sessions', async () => {
    const createRes = await post('/api/executives', {
      name: 'Sahil Sharma',
      phone: '+919811122233',
      email: 'sahil@climeto.com',
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.success, true);
    assert.equal(createRes.body.data.name, 'Sahil Sharma');
    assert.equal(createRes.body.data.phone, '+919811122233');

    const sessRes = await get('/api/whatsapp/sessions');
    const sahil = sessRes.body.data.find((e) => e.executiveId === createRes.body.data.id);
    assert.ok(sahil, 'Newly added executive should appear in WhatsApp sessions list');
    assert.equal(sahil.phone, '+919811122233');
  });
});

