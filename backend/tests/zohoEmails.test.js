import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-zoho-emails.db');

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const { initializeDb, listZohoEmails, upsertZohoEmail, getZohoEmailsStats } = await import(
  '../src/db.js'
);
const { createApp } = await import('../src/createApp.js');

let server;
let baseUrl;

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

describe('Zoho Executive Emails API & DB', () => {
  before(async () => {
    await initializeDb();
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        upsertZohoEmail({
          externalId: 'test-email-1',
          executiveName: 'Ambuj Pathak',
          executiveEmail: 'ambuj@climeto.com',
          direction: 'outbound',
          recipientEmail: 'client@example.com',
          subject: 'EPR Quotation Details',
          summary: 'Sent EPR compliance quote',
        });
        upsertZohoEmail({
          externalId: 'test-email-2',
          executiveName: 'Sahil',
          executiveEmail: 'sahil@climeto.com',
          direction: 'inbound',
          senderEmail: 'client@example.com',
          subject: 'Re: CPCB Certificate',
          summary: 'Client requested certificate sample',
        });
        resolve();
      });
    });
  });

  after(() => {
    if (server) server.close();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {
        // ignore
      }
    }
  });

  test('GET /api/zoho/emails returns emails list and executive stats', async () => {
    const res = await get('/api/zoho/emails');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.emails));
    assert.ok(res.body.data.emails.length >= 1);
    assert.ok(res.body.data.stats);
    assert.ok(res.body.data.stats.total >= 1);
    assert.ok(res.body.data.stats.activeExecutives >= 1);
  });

  test('Filtering emails by executive and direction works', async () => {
    const res = await get('/api/zoho/emails?executive=Ambuj&direction=outbound');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.emails.length >= 1);
    assert.ok(res.body.data.emails.every((e) => e.direction === 'outbound'));
  });

  test('Search filter on Zoho emails works', async () => {
    const res = await get('/api/zoho/emails?search=EPR');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.emails.length >= 1);
    assert.ok(
      res.body.data.emails.some((e) => e.subject.includes('EPR') || e.summary.includes('EPR')),
    );
  });

  test('upsertZohoEmail updates and creates activity', () => {
    const email = {
      externalId: 'test-email-msg-999',
      executiveName: 'Test Executive',
      executiveEmail: 'test.exec@climeto.com',
      clientName: 'Test Corp',
      clientEmail: 'contact@testcorp.com',
      direction: 'outbound',
      subject: 'Test Subject Quotation',
      summary: 'Testing summary',
      sentAt: new Date().toISOString(),
    };

    const ins = upsertZohoEmail(email);
    assert.equal(ins.inserted, true);

    const upd = upsertZohoEmail({
      ...email,
      summary: 'Testing summary updated',
    });
    assert.equal(upd.updated, true);

    const list = listZohoEmails({ search: 'Test Subject' });
    assert.equal(list.length, 1);
    assert.equal(list[0].summary, 'Testing summary updated');
  });

  test('POST /api/webhooks/zoho-emails ingests real-time incoming email', async () => {
    const res = await post('/api/webhooks/zoho-emails', {
      message_id: 'webhook-msg-001',
      from_email: 'buyer@industrial.com',
      from_name: 'Industrial Buyer',
      to_email: 'ambuj@climeto.com',
      to_name: 'Ambuj Pathak',
      subject: 'Purchase Order Confirmation #9821',
      snippet: 'We have approved the quotation and PO is attached.',
      sent_time: new Date().toISOString(),
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const emails = listZohoEmails({ search: 'Purchase Order Confirmation' });
    assert.ok(emails.length >= 1);
    assert.equal(emails[0].direction, 'inbound');
  });
});
