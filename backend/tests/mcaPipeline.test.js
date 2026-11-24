import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-mca-dossier.db');

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const {
  initializeDb,
  saveCompanySearch,
  getRecentCompanySearches,
  getCachedDossier,
  setCachedDossier,
} = await import('../src/db.js');
const { searchByName, getMasterData, getFinancials } = await import('../src/services/mcaProvider.js');
const { mergeSectionA, createUnifiedDossier, buildField } = await import('../src/services/dossierMerge.js');
const { classifyIndustry } = await import('../src/services/industryClassifier.js');
const { createApp } = await import('../src/createApp.js');

await initializeDb();

describe('Prompt 1: Section A (Company Profile) Real Data Pipeline', () => {
  let app;
  let server;
  let baseUrl;

  before(async () => {
    app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(() => {
    if (server) server.close();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {}
    }
  });

  test('mcaProvider throws clear error when unconfigured, never falling back to mock data', async () => {
    delete process.env.MCA_PROVIDER_API_KEY;
    await assert.rejects(
      async () => {
        await searchByName('Balaji Wafers');
      },
      (err) => {
        assert.match(err.message, /not configured/i);
        return true;
      },
    );

    await assert.rejects(
      async () => {
        await getMasterData('U12345GJ2012PTC012345');
      },
      (err) => {
        assert.match(err.message, /not configured/i);
        return true;
      },
    );
  });

  test('dossierMerge creates per-field sourced objects with zero fake numbers', () => {
    const sectionA = mergeSectionA({
      mcaMaster: {
        name: 'Balaji Wafers Private Limited',
        cin: 'U15400GJ1992PTC018501',
        type: 'Private Limited',
        status: 'Active',
        state: 'Gujarat',
        registered_address: 'Vajdi (Vad), Kalawad Road, Rajkot, Gujarat',
        incorporation_date: '1992-10-21',
        nic_description: 'Manufacture of potato chips and snacks',
      },
      financials: {
        financial_year: '2023-24',
        turnover_inr: 52000000000,
      },
      websiteData: {
        website: 'https://balajiwafers.com',
        email: 'contact@balajiwafers.com',
        phone: '+91 281 2783701',
      },
      industryData: {
        industry: 'Snack Food Manufacturing',
        business_category: 'Potato & Banana Wafers Processing',
        source: 'ai_summary',
        confidence: 0.6,
        derived_by: 'ai',
      },
    });

    // Check MCA fields
    assert.equal(sectionA.company_name.value, 'Balaji Wafers Private Limited');
    assert.equal(sectionA.company_name.source, 'mca');
    assert.equal(sectionA.company_name.confidence, 1.0);
    assert.equal(sectionA.company_name.derived_by, 'api');

    assert.equal(sectionA.cin.value, 'U15400GJ1992PTC018501');
    assert.equal(sectionA.cin.source, 'mca');

    // Check Turnover includes financial year
    assert.equal(sectionA.annual_turnover.value, 'INR 5200 Cr (FY 2023-24)');
    assert.equal(sectionA.annual_turnover.source, 'financial_filing');

    // Check Website & Scraped Contact
    assert.equal(sectionA.website.value, 'https://balajiwafers.com');
    assert.equal(sectionA.website.source, 'company_website');
    assert.equal(sectionA.company_email.value, 'contact@balajiwafers.com');

    // Check Unified Dossier format
    const unified = createUnifiedDossier(sectionA);
    assert.ok(unified.section_a);
    assert.equal(unified.section_b, null, 'Section B must be null before call');
    assert.equal(unified.section_c, null, 'Section C must be null before call');
  });

  test('dossierMerge sets missing fields strictly to value: null', () => {
    const emptySectionA = mergeSectionA({
      mcaMaster: { name: 'New Startup Pvt Ltd', cin: 'U99999DL2024PTC111111' },
      financials: { financial_year: null, turnover_inr: null },
      websiteData: {},
      industryData: {},
    });

    assert.equal(emptySectionA.annual_turnover.value, null);
    assert.equal(emptySectionA.employee_count.value, null);
    assert.equal(emptySectionA.website.value, null);
    assert.equal(emptySectionA.company_email.value, null);
    assert.equal(emptySectionA.company_phone.value, null);
    assert.equal(emptySectionA.business_category.value, null);
  });

  test('industryClassifier falls back strictly to MCA NIC description if verbatim evidence is missing', async () => {
    const result = await classifyIndustry({
      nicDescription: 'Manufacture of corrugated paper and paperboard',
      aboutText: 'Welcome to our company website.', // Too short / no matching evidence
    });

    assert.equal(result.industry, 'Manufacture of corrugated paper and paperboard');
    assert.equal(result.business_category, null);
    assert.equal(result.source, 'mca');
    assert.equal(result.confidence, 1.0);
  });

  test('company_search_history and company_dossier_cache store and retrieve cleanly', () => {
    // 1. Save search history
    saveCompanySearch({ query: 'Balaji Wafers', cin: 'U15400GJ1992PTC018501', name: 'Balaji Wafers Pvt Ltd' });
    const recent = getRecentCompanySearches(5);
    assert.ok(recent.length >= 1);
    assert.equal(recent[0].name, 'Balaji Wafers Pvt Ltd');
    assert.equal(recent[0].cin, 'U15400GJ1992PTC018501');

    // 2. Cache dossier
    const fakeSectionA = {
      company_name: buildField({ value: 'Balaji Wafers Pvt Ltd', source: 'mca' }),
      cin: buildField({ value: 'U15400GJ1992PTC018501', source: 'mca' }),
    };
    setCachedDossier('U15400GJ1992PTC018501', fakeSectionA, 7);

    const cached = getCachedDossier('U15400GJ1992PTC018501');
    assert.ok(cached);
    assert.equal(cached.section_a.company_name.value, 'Balaji Wafers Pvt Ltd');
  });

  test('GET /api/training/intel/recent-searches returns recent searches from DB', async () => {
    const res = await fetch(`${baseUrl}/api/training/intel/recent-searches`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.data.some((item) => item.name === 'Balaji Wafers Pvt Ltd'));
  });

  test('GET /api/training/intel/search-companies returns 503 error when provider not configured', async () => {
    const res = await fetch(`${baseUrl}/api/training/intel/search-companies?q=Balaji`);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.message, /not configured/i);
  });
});
