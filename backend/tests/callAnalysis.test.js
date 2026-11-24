import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '../data/test-call-analysis.db');

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = testDbPath;

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const {
  initializeDb,
  saveCallExtraction,
  saveBatchCallExtractions,
  getCallExtractionsByCallId,
  updateCallExtractionField,
} = await import('../src/db.js');

const {
  validateCallAnalysis,
  validateEvidenceField,
  computeTokenOverlap,
  isValidEmail,
  isValidPhone,
} = await import('../src/services/callValidators.js');

const { createApp } = await import('../src/createApp.js');

await initializeDb();

describe('Prompt 2: Section B + C Call Analysis with Evidence Validation', () => {
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

  // Test 1: Rich Hinglish transcript with valid evidence quotes
  test('1. Valid Hinglish call extracts evidence-backed facts and passes validation', () => {
    const transcript = `
[00:05] Sales: Namaste, kya meri baat Sunil ji se ho rahi hai?
[00:10] Client: Haanji, Sunil Singhal bol raha hoon, Director of Operations.
[00:15] Client: Humari factory me lagbhag 250 workers aur staff hain.
[00:18] Sales: Sunil ji, Climeto se call hai regarding EPR plastic packaging compliance.
[00:25] Client: Achha, humara rigid plastic packaging ka plant hai Vapi me, hume CPCB portal filing me help chahiye.
[00:35] Sales: Current vendor kaun hai aapka?
[00:40] Client: Abhi hum EcoRecycle ke saath kaam kar rahe hain par unka service bohot slow hai.
[00:50] Client: Humara annual compliance budget lagbhag 15 Lakhs hai.
[01:05] Client: Aap mujhe agale mangalwar 3 baje call kijiye draft agreement ke saath.
`;

    const rawExtraction = {
      call_quality: { usable: true, language_detected: 'hinglish', reason: null },
      call_summary: { summary: 'Client interested in EPR compliance switch', outcome: 'follow_up_agreed' },
      contact_person: {
        contact_name: { value: 'Sunil Singhal', evidence: 'Sunil Singhal bol raha hoon', timestamp: '00:10', confidence: 0.95 },
        designation: { value: 'Director of Operations', evidence: 'Director of Operations', timestamp: '00:10', confidence: 0.95 },
        department: { value: 'Operations', evidence: 'Director of Operations', timestamp: '00:10', confidence: 0.85 },
        company_headcount: { value: '250 workers and staff', evidence: 'Humari factory me lagbhag 250 workers aur staff hain', timestamp: '00:15', confidence: 0.95 },
        phone: { value: null, evidence: null, timestamp: null, confidence: 0 },
        email: { value: null, evidence: null, timestamp: null, confidence: 0 },
        seniority: { value: 'head_director', evidence: 'Director of Operations', timestamp: '00:10', confidence: 0.9 },
        decision_authority: { value: 'decision_maker', evidence: 'Director of Operations', timestamp: '00:10', confidence: 0.8 },
      },
      sales_intelligence: {
        client_requirement: { value: 'CPCB Portal Filing & Rigid Plastic Packaging EPR', evidence: 'rigid plastic packaging ka plant hai Vapi me, hume CPCB portal filing me help chahiye', timestamp: '00:25', confidence: 0.95 },
        main_problem: { value: 'Slow service from existing vendor', evidence: 'unka service bohot slow hai', timestamp: '00:40', confidence: 0.9 },
        current_vendor: { value: 'EcoRecycle', evidence: 'Abhi hum EcoRecycle ke saath kaam kar rahe hain', timestamp: '00:40', confidence: 0.95 },
        budget: { value: 'INR 15 Lakhs', amount_inr: 1500000, evidence: 'annual compliance budget lagbhag 15 Lakhs hai', timestamp: '00:50', confidence: 0.9 },
        lead_temperature: { value: 'hot', confidence: 0.9 },
        temperature_signals: [{ signal: 'Budget declared & switch intent', evidence: 'service bohot slow hai', timestamp: '00:40' }],
        next_followup: { action: 'Call with draft agreement', datetime_iso: null, raw_phrase: 'agale mangalwar 3 baje', evidence: 'agale mangalwar 3 baje call kijiye draft agreement ke saath', timestamp: '01:05', confidence: 0.9 },
      },
    };

    const validated = validateCallAnalysis(rawExtraction, transcript);

    assert.equal(validated.contact_person.contact_name.value, 'Sunil Singhal');
    assert.equal(validated.contact_person.contact_name.needs_review, false);
    assert.equal(validated.contact_person.designation.value, 'Director of Operations');
    assert.equal(validated.contact_person.department.value, 'Operations');
    assert.equal(validated.contact_person.company_headcount.value, '250 workers and staff');
    assert.equal(validated.sales_intelligence.current_vendor.value, 'EcoRecycle');
    assert.equal(validated.sales_intelligence.budget.amount_inr, 1500000);
    assert.equal(validated.sales_intelligence.next_followup.value, 'Call with draft agreement');
  });

  // Test 2: Call where most fields are NOT said (must return nulls)
  test('2. Uninformative call returns mostly null fields with zero hallucination', () => {
    const transcript = `
[00:02] Sales: Hello, Climeto se baat kar raha hoon.
[00:08] Client: Haan main sun raha hoon, par abhi urgent meeting me hoon, baad me dekhna.
[00:14] Sales: Theek hai sir, thank you.
`;

    const rawExtraction = {
      call_quality: { usable: true, language_detected: 'hinglish', reason: null },
      call_summary: { summary: 'Client busy in meeting', outcome: 'no_clear_outcome' },
      contact_person: {
        contact_name: { value: null, evidence: null, timestamp: null, confidence: 0 },
        designation: { value: null, evidence: null, timestamp: null, confidence: 0 },
        department: { value: null, evidence: null, timestamp: null, confidence: 0 },
        company_headcount: { value: null, evidence: null, timestamp: null, confidence: 0 },
        phone: { value: null, evidence: null, timestamp: null, confidence: 0 },
        email: { value: null, evidence: null, timestamp: null, confidence: 0 },
        seniority: { value: 'unknown', evidence: null, timestamp: null, confidence: 0 },
        decision_authority: { value: 'unknown', evidence: null, timestamp: null, confidence: 0 },
      },
      sales_intelligence: {
        client_requirement: { value: null, evidence: null, timestamp: null, confidence: 0 },
        main_problem: { value: null, evidence: null, timestamp: null, confidence: 0 },
        current_vendor: { value: null, evidence: null, timestamp: null, confidence: 0 },
        budget: { value: null, amount_inr: null, evidence: null, timestamp: null, confidence: 0 },
        lead_temperature: { value: 'cold', confidence: 0.7 },
        temperature_signals: [],
        next_followup: { action: null, datetime_iso: null, raw_phrase: null, evidence: null, timestamp: null, confidence: 0 },
      },
    };

    const validated = validateCallAnalysis(rawExtraction, transcript);

    assert.equal(validated.contact_person.contact_name.value, null);
    assert.equal(validated.contact_person.designation.value, null);
    assert.equal(validated.contact_person.department.value, null);
    assert.equal(validated.contact_person.company_headcount.value, null);
    assert.equal(validated.sales_intelligence.client_requirement.value, null);
    assert.equal(validated.sales_intelligence.current_vendor.value, null);
    assert.equal(validated.sales_intelligence.budget.value, null);
    assert.equal(validated.sales_intelligence.next_followup.value, null);
  });

  // Test 3: Fabricated quote detection (must reject and set value=null)
  test('3. Fabricated quote detection rejects hallucinations and forces value: null', () => {
    const transcript = `
[00:05] Client: Hum packaging box banate hain.
`;

    // AI hallucinates a budget quote that was never spoken in the call
    const fakeField = {
      value: 'INR 50 Lakhs',
      evidence: 'humara annual budget pachas lakh hai',
      timestamp: '00:20',
      confidence: 0.9,
    };

    const validated = validateEvidenceField('budget', fakeField, transcript);

    assert.equal(validated.value, null, 'Value must be forced to null for fabricated quotes');
    assert.equal(validated.confidence, 0);
    assert.equal(validated.needs_review, true);
    assert.equal(validated.reason, 'evidence_not_found');
  });

  // Test 4: Hinglish fuzzy token overlap check
  test('4. Hinglish phonetic variations pass token overlap validation', () => {
    const transcript = `[00:15] Client: Haan ji theek hai, mujhe proposal bhej do kal tak.`;
    
    // Slight spelling difference: 'thik hai' vs 'theek hai'
    const overlap = computeTokenOverlap('haan ji thik hai mujhe proposal bhej do', transcript);
    assert.ok(overlap >= 0.85, `Token overlap should be >= 0.85, got ${overlap}`);
  });

  // Test 5: Low confidence (< 0.6) sets needs_review: true
  test('5. Low confidence extraction flags needs_review: true', () => {
    const transcript = `[00:15] Client: Shayad hum thoda plastic recycling bhi dekhenge baad me.`;
    const field = {
      value: 'Plastic Recycling',
      evidence: 'plastic recycling bhi dekhenge',
      timestamp: '00:15',
      confidence: 0.52, // Below 0.6
    };

    const validated = validateEvidenceField('client_requirement', field, transcript);
    assert.equal(validated.value, 'Plastic Recycling');
    assert.equal(validated.needs_review, true, 'Low confidence must set needs_review: true');
  });

  // Test 6: Format validation on email and phone
  test('6. Invalid email and phone formats are rejected and nulled', () => {
    const transcript = `[00:10] Client: Mera number 1234 hai aur email abc-not-an-email hai.`;

    const badEmail = validateEvidenceField('email', {
      value: 'abc-not-an-email',
      evidence: 'email abc-not-an-email hai',
      timestamp: '00:10',
      confidence: 0.8,
    }, transcript);
    assert.equal(badEmail.value, null);
    assert.equal(badEmail.reason, 'invalid_email_format');

    const badPhone = validateEvidenceField('phone', {
      value: '1234',
      evidence: 'number 1234 hai',
      timestamp: '00:10',
      confidence: 0.8,
    }, transcript);
    assert.equal(badPhone.value, null);
    assert.equal(badPhone.reason, 'invalid_phone_format');
  });

  // Test 7: Human verification preservation
  test('7. AI extractions never overwrite human_verified values', () => {
    const existingHuman = {
      value: 'Vikram Taparia',
      evidence: 'Manually verified by BD executive',
      timestamp: 'Manual',
      confidence: 1.0,
      source: 'human_verified',
      needs_review: false,
    };

    const aiField = {
      value: 'V. Taparia',
      evidence: 'boliye Taparia ji',
      timestamp: '00:05',
      confidence: 0.7,
    };

    const result = validateEvidenceField('contact_name', aiField, 'boliye Taparia ji', existingHuman);
    assert.equal(result.value, 'Vikram Taparia', 'Human verified value must be preserved');
    assert.equal(result.source, 'human_verified');
    assert.equal(result.suggested_value, 'V. Taparia');
  });

  // Test 8: Storage and Endpoints (GET /api/calls/:id/analysis and PATCH /api/calls/:id/fields/:fieldName)
  test('8. Database storage and API endpoints work end-to-end', async () => {
    const callId = 'test-call-evidence-99';

    // 1. Save extraction batch
    saveCallExtraction({
      callId,
      fieldName: 'contact_person.contact_name',
      value: 'Rakesh Mehta',
      evidence: 'Rakesh Mehta from Mehta Polyesters',
      timestamp: '00:08',
      confidence: 0.95,
      needsReview: false,
      source: 'call_ai',
    });

    saveCallExtraction({
      callId,
      fieldName: 'sales_intelligence.client_requirement',
      value: 'EPR Certificate Filing',
      evidence: 'EPR certificate filing karwana hai',
      timestamp: '00:22',
      confidence: 0.9,
      needsReview: false,
      source: 'call_ai',
    });

    // 2. Fetch analysis via API
    const res = await fetch(`${baseUrl}/api/calls/${callId}/analysis`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.section_b);
    assert.equal(json.data.section_b.contact_name.value, 'Rakesh Mehta');
    assert.equal(json.data.section_b.contact_name.timestamp, '00:08');
    assert.ok(json.data.section_c);
    assert.equal(json.data.section_c.client_requirement.value, 'EPR Certificate Filing');

    // 3. Patch field manually (BD correction)
    const patchRes = await fetch(`${baseUrl}/api/calls/${callId}/fields/contact_person.contact_name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'Rakesh C. Mehta' }),
    });
    assert.equal(patchRes.status, 200);
    const patchJson = await patchRes.json();
    assert.equal(patchJson.success, true);
    assert.equal(patchJson.data.value, 'Rakesh C. Mehta');
    assert.equal(patchJson.data.source, 'human_verified');

    // 4. Verify updated value in analysis endpoint
    const resAfter = await fetch(`${baseUrl}/api/calls/${callId}/analysis`);
    const jsonAfter = await resAfter.json();
    assert.equal(jsonAfter.data.section_b.contact_name.value, 'Rakesh C. Mehta');
    assert.equal(jsonAfter.data.section_b.contact_name.source, 'human_verified');
  });
});
