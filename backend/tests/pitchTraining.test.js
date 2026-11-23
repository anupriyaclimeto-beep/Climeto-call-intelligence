import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-pitch-training.db');

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const { initializeDb, createCompletedCall } = await import('../src/db.js');
const { createApp } = await import('../src/createApp.js');
const { enqueueLiveCallEvaluation } = await import('../src/services/pitchAnalyzer.js');

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
            resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
          } catch {
            resolve({ status: res.statusCode, body: data, raw: data });
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

describe('Pitch Training API (Smart Playbook, AI Analyzer, Feedback Loop & Roleplay)', () => {
  test('GET /api/training/playbook returns seeded Climeto EPR playbook rules and supports CRUD', async () => {
    const listRes = await request('GET', '/api/training/playbook');
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.data.length >= 8);

    const createRes = await request('POST', '/api/training/playbook', {
      category: 'objection',
      title: 'CPCB Audit Concern',
      client_cue: 'What if CPCB audits our credits?',
      ideal_response: 'All Climeto credits are CPCB-portal verified with full audit documentation.',
    });
    assert.equal(createRes.status, 201);
    const createdId = createRes.body.data.id;
    assert.ok(createdId);

    const delRes = await request('DELETE', `/api/training/playbook/${createdId}`);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.data.deleted, true);
  });

  test('POST /api/training/evaluate/call/:id evaluates a call and manager feedback exports to JSONL', async () => {
    const evalRes = await request('POST', '/api/training/evaluate/call/call-01');
    assert.equal(evalRes.status, 201);
    assert.equal(evalRes.body.success, true);
    const ev = evalRes.body.data;
    assert.ok(ev.id);
    assert.ok(ev.overall_score > 0);
    assert.ok(ev.scores.discovery >= 0);
    assert.ok(ev.try_line.length > 5);

    // Manager approves and promotes try_line to Playbook
    const fbRes = await request('POST', `/api/training/evaluations/${ev.id}/feedback`, {
      managerStatus: 'approved',
      managerScore: 8.5,
      managerNote: 'Good discovery, lock exact callback time.',
      managerTryLine: 'Sir kal 11 AM par quote review call lock kar lein?',
      addToPlaybook: true,
    });
    assert.equal(fbRes.status, 200);
    assert.equal(fbRes.body.data.manager_status, 'approved');
    assert.equal(fbRes.body.data.manager_score, 8.5);

    // Coaching summary reflects evaluated + approved counts
    const coachRes = await request('GET', '/api/training/coaching');
    assert.equal(coachRes.status, 200);
    assert.ok(coachRes.body.data.stats.total_evaluated >= 1);
    assert.ok(coachRes.body.data.stats.manager_approved >= 1);
    assert.ok(coachRes.body.data.executives.length >= 1);

    // Export JSONL for Fine-Tuning
    const exportRes = await request('GET', '/api/training/export-jsonl');
    assert.equal(exportRes.status, 200);
    assert.ok(exportRes.raw.includes('Sir kal 11 AM par quote review call lock kar lein?'));
  });

  test('POST /api/training/suggest-reply/:leadId returns actionable reply for WhatsApp', async () => {
    const res = await request('POST', '/api/training/suggest-reply/lead-1', { channel: 'whatsapp' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.suggested_message.length > 10);
    assert.ok(Array.isArray(res.body.data.questions_to_ask));
  });

  test('AI Roleplay Arena: start, message exchange, and final coaching scorecard', async () => {
    const startRes = await request('POST', '/api/training/roleplay/start', {
      executiveName: 'Ambuj Pathak',
      scenarioId: 'price-negotiator',
    });
    assert.equal(startRes.status, 201);
    const sessionId = startRes.body.data.id;
    assert.equal(startRes.body.data.messages.length, 1);

    const msgRes = await request('POST', `/api/training/roleplay/${sessionId}/message`, {
      message: 'Sir aapka annual EPR volume kitne MT hai aur kaunsi plastic category hai? Climeto 100% CPCB verified certificates deta hai.',
    });
    assert.equal(msgRes.status, 200);
    assert.equal(msgRes.body.data.messages.length, 3);

    const finishRes = await request('POST', `/api/training/roleplay/${sessionId}/finish`);
    assert.equal(finishRes.status, 200);
    assert.equal(finishRes.body.data.status, 'completed');
    assert.ok(finishRes.body.data.score.overall_score > 0);
  });

  test('Dual-lane call pitch training: historical backfill + side-by-side live auto-train', async () => {
    // Seed 3 additional older calls
    for (let i = 1; i <= 3; i += 1) {
      createCompletedCall({
        id: `hist-call-${i}`,
        clientName: `Historical PIBO ${i}`,
        clientPhone: `+91980001000${i}`,
        executiveName: 'Ambuj Pathak',
        durationSeconds: 120,
        summary: `Historical EPR call ${i}`,
        transcript: `Executive: Namaste sir, Climeto EPR Category II 50 MT plastic credits ke baare me baat karni thi.\nClient: Quotation WhatsApp kar dijiye kal 11 AM follow up rakhte hain.`,
      });
    }

    // Start historical backfill
    const startRes = await request('POST', '/api/training/backfill/start', {
      targetCount: 100,
      syncOlderCalls: false,
    });
    assert.equal(startRes.status, 202);
    assert.equal(startRes.body.success, true);

    // Wait briefly for test-mode worker (0ms delay) to complete
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const statusRes = await request('GET', '/api/training/backfill/status');
      assert.equal(statusRes.status, 200);
      if (!statusRes.body.data.running && !statusRes.body.data.worker_active) {
        assert.ok(statusRes.body.data.call_coverage.calls_evaluated >= 4);
        assert.equal(statusRes.body.data.call_coverage.calls_pending, 0);
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }

    // Side-by-side live new call auto-training
    createCompletedCall({
      id: 'live-new-call-1',
      clientName: 'Brand New Live Prospect',
      clientPhone: '+919899991111',
      executiveName: 'Ram Bangad',
      durationSeconds: 95,
      summary: 'New live call completed',
      transcript: 'Executive: Sir aapka Category III EPR volume kitna MT hai? Kal 12 PM quote discuss karein?',
    });

    const liveQueued = enqueueLiveCallEvaluation('live-new-call-1');
    assert.equal(liveQueued.queued, true);
    assert.equal(liveQueued.lane, 'live');

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const statusRes = await request('GET', '/api/training/backfill/status');
      if (statusRes.body.data.live_processed >= 1) {
        assert.ok(statusRes.body.data.call_coverage.calls_evaluated >= 5);
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }

    // Toggle auto-train off and back on, and verify stop endpoint
    const offRes = await request('POST', '/api/training/auto-train', { enabled: false });
    assert.equal(offRes.status, 200);
    assert.equal(offRes.body.data.auto_train_enabled, false);

    const onRes = await request('POST', '/api/training/auto-train', { enabled: true });
    assert.equal(onRes.status, 200);
    assert.equal(onRes.body.data.auto_train_enabled, true);

    const stopRes = await request('POST', '/api/training/backfill/stop');
    assert.equal(stopRes.status, 200);
    assert.equal(stopRes.body.data.running, false);
  });
});

