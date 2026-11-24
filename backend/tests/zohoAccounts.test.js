import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-zoho-accounts.db');

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const { initializeDb, listZohoAccounts, upsertZohoAccount } = await import('../src/db.js');
const { createApp } = await import('../src/createApp.js');

let server;
let baseUrl;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${urlPath}`, (res) => {
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
    }).on('error', reject);
  });
}

describe('Zoho Accounts API & DB', () => {
  before(async () => {
    await initializeDb();
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        upsertZohoAccount({
          id: 'test-acc-1',
          accountName: 'Apex Packaging Ltd',
          industry: 'Manufacturing',
          annualRevenue: '₹50 Cr',
          billingCity: 'Mumbai',
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

  test('GET /api/zoho/accounts returns metadata and account records', async () => {
    const res = await get('/api/zoho/accounts');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.meta);
    assert.ok(Array.isArray(res.body.data.accounts));
    assert.ok(res.body.data.accounts.length > 0);
    assert.ok(res.body.data.authStatus);
  });

  test('Search filter on Zoho accounts works', async () => {
    const res = await get('/api/zoho/accounts?search=Apex');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.accounts.length >= 1);
    assert.ok(res.body.data.accounts.some((a) => a.account_name.includes('Apex')));
  });

  test('upsertZohoAccount inserts and updates cleanly', () => {
    const testId = 'test-company-999';
    const ins = upsertZohoAccount({
      id: testId,
      accountName: 'Test Green Energy Corp',
      industry: 'Solar',
      billingCity: 'Jaipur',
    });
    assert.equal(ins.inserted, true);

    const upd = upsertZohoAccount({
      id: testId,
      accountName: 'Test Green Energy Corp Updated',
      industry: 'Solar Tech',
      billingCity: 'Jaipur',
    });
    assert.equal(upd.updated, true);

    const accounts = listZohoAccounts({ search: 'Test Green' });
    assert.ok(accounts.some((a) => a.account_name === 'Test Green Energy Corp Updated'));
  });
});
