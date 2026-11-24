import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-client-intel.db');

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const {
  initializeDb,
  getClientIntelById,
  getClientIntelByTarget,
  listClientIntel,
  syncClientIntelToZoho,
  upsertClientIntel,
} = await import('../src/db.js');
const { createApp } = await import('../src/createApp.js');
const {
  enrichCompanyProfile,
  lookupVerifiedCompany,
} = await import('../src/services/companyIntelEnricher.js');
const {
  extractAndSaveClientIntel,
} = await import('../src/services/clientIntelExtractor.js');

await initializeDb();

test('Company Intel Enrichment Service (Zero Fake Data Guarantee)', async (t) => {
  await t.test('purged registry returns null and does not return hardcoded corporate cards', () => {
    const res = lookupVerifiedCompany('Balaji Wafers Pvt Ltd');
    assert.equal(res, null, 'Hardcoded registry must be purged and return null');
  });

  await t.test('enriches unknown company without hallucinating fake numbers or emails', async () => {
    const profile = await enrichCompanyProfile({
      companyName: 'Nova Polymers Pvt Ltd',
      locationHint: 'Vapi, Gujarat',
    });
    assert.equal(profile.company_name, 'Nova Polymers Pvt Ltd');
    assert.equal(profile.company_type, 'Private Limited');
    assert.equal(profile.location, 'Vapi, Gujarat');
    assert.equal(profile.annual_turnover, null, 'Turnover must be null when unverified, never fake benchmark');
    assert.equal(profile.employee_count, null, 'Headcount must be null when unverified');
  });
});

test('Client Intel Extraction & Auto-Sync to Zoho CRM', async (t) => {
  const app = createApp();

  await t.test('extracts 360-degree client profiling for a call without fake defaults', async () => {
    const intel = await extractAndSaveClientIntel({
      targetType: 'call',
      targetId: 'call-intel-test-1',
      transcript:
        'Hello Rahul ji, main Climeto se baat kar raha hoon. Rahul Sharma here from ABC Industries. Hum packaging waste management dekh rahe hain aur CPCB compliance chahiye.',
      clientName: 'Rahul Sharma',
      companyName: 'ABC Industries',
      phone: '+91 98765 43210',
    });

    assert.ok(intel, 'Intel record should be created');
    assert.equal(intel.company_name, 'ABC Industries');
    assert.equal(intel.contact_name, 'Rahul Sharma');

    const fetched = getClientIntelByTarget('call', 'call-intel-test-1');
    assert.equal(fetched.id, intel.id);
  });

  await t.test('POST /api/training/intel/lookup-company returns unverified null metrics cleanly', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/training/intel/lookup-company`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_name: 'Balaji Wafers' }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.company_name, 'Balaji Wafers');
      assert.equal(json.data.annual_turnover, null, 'Turnover must be null');
    } finally {
      server.close();
    }
  });

  await t.test('POST /api/training/intel/:id/sync-zoho pushes company to Zoho Accounts', async () => {
    const intel = upsertClientIntel({
      target_type: 'call',
      target_id: 'call-sync-test-99',
      company_name: 'Supreme Industries Ltd',
      location: 'Mumbai, Maharashtra',
      annual_turnover: 'INR 10,134 Cr (FY 2023-24)',
      industry: 'Plastics & Mouldings',
      contact_name: 'Mr. Taparia',
      lead_temperature: 'Hot',
    });

    const synced = syncClientIntelToZoho(intel.id);
    assert.equal(synced.synced_to_zoho, 1);
    assert.ok(synced.zoho_synced_at);
  });
});
