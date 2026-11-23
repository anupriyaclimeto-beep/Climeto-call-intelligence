import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-knowledge-base.db');

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const { initializeDb } = await import('../src/db.js');
const { createApp } = await import('../src/createApp.js');
const { ingestUploadedFiles, buildKnowledgeContextBlock } = await import('../src/services/knowledgeBase.js');

let server;
let baseUrl;

function request(method, urlPath, body = null) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${urlPath}`,
      {
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {},
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
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  await initializeDb();
  const app = createApp();
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

describe('EPR Knowledge Base (PDF / DOCX / ZIP / TXT ingestion & Playbook generation)', () => {
  test('Ingests ZIP archive containing EPR guidelines and injects into AI context', async () => {
    const zip = new AdmZip();
    zip.addFile(
      'CPCB_EPR_Categories.txt',
      Buffer.from('Category I is Rigid Plastic, Category II is Flexible Plastic, Category III is Multi-layered Plastic (MLP). PIBOs must register on the CPCB EPR portal.', 'utf8'),
    );
    zip.addFile(
      'Climeto_Pricing_Guide.md',
      Buffer.from('Always verify annual MT volume and category before issuing a commercial quote for plastic credits.', 'utf8'),
    );

    const res = await ingestUploadedFiles([
      { originalname: 'epr-docs-bundle.zip', buffer: zip.toBuffer() },
    ]);

    assert.equal(res.ingested.length, 2);
    assert.equal(res.skipped.length, 0);

    const listRes = await request('GET', '/api/training/knowledge');
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.length, 2);

    const context = buildKnowledgeContextBlock();
    assert.ok(context.includes('Category I is Rigid Plastic'));
    assert.ok(context.includes('Climeto Pricing Guide'));

    // Generate playbook rules from uploaded EPR docs
    const genRes = await request('POST', '/api/training/knowledge/generate-playbook');
    assert.equal(genRes.status, 201);
    assert.ok(genRes.body.data.created_count >= 1);

    // Toggle doc inactive and delete
    const firstId = listRes.body.data[0].id;
    const toggleRes = await request('PATCH', `/api/training/knowledge/${firstId}`, { is_active: false });
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.body.data.is_active, 0);

    const delRes = await request('DELETE', `/api/training/knowledge/${firstId}`);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.data.deleted, true);
  });
});

