/**
 * Call Analysis Validation Layer
 * 
 * Enforces strict evidence validation, Hinglish fuzzy token overlap,
 * confidence thresholds, format validation, and human-verified preservation.
 * 
 * STRICT RULES:
 * - For each non-null field, evidence must match transcript (exact or token overlap >= 0.85).
 * - If evidence check fails: value = null, confidence = 0, needs_review = true, reason: 'evidence_not_found'.
 * - confidence < 0.6 -> needs_review = true.
 * - Format validation on phone & email: invalid -> null.
 * - Never overwrite a human_verified value with an AI value.
 */

export function normalizeTranscriptText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a = '', b = '') {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

export function computeTokenOverlap(evidenceText = '', transcriptText = '') {
  const evNorm = normalizeTranscriptText(evidenceText);
  const trNorm = normalizeTranscriptText(transcriptText);

  if (!evNorm) return 0;
  if (trNorm.includes(evNorm)) return 1.0;

  const evTokens = evNorm.split(' ').filter((w) => w.length > 1);
  if (evTokens.length === 0) return 0;

  const trTokens = new Set(trNorm.split(' ').filter((w) => w.length > 1));
  let matched = 0;

  for (const token of evTokens) {
    if (trTokens.has(token)) {
      matched++;
    } else {
      // Fuzzy match for minor Hinglish phonetic variations (e.g., theek/thik, haan/ha, achha/acha)
      let found = false;
      for (const t of trTokens) {
        if (Math.abs(t.length - token.length) <= 2 && levenshteinDistance(t, token) <= 1) {
          matched++;
          found = true;
          break;
        }
      }
      if (!found && token.length > 4) {
        // Substring match for compound words
        for (const t of trTokens) {
          if (t.includes(token) || token.includes(t)) {
            matched += 0.8;
            break;
          }
        }
      }
    }
  }

  return Math.min(1.0, matched / evTokens.length);
}

export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
}

export function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13;
}

/**
 * Validates a single evidence field against the raw transcript
 */
export function validateEvidenceField(fieldName, fieldData, fullTranscript = '', existingRecord = null) {
  if (!fieldData || typeof fieldData !== 'object') {
    return {
      value: null,
      evidence: null,
      timestamp: null,
      confidence: 0,
      needs_review: false,
    };
  }

  // If already verified by human, AI suggestion must never overwrite
  if (existingRecord?.source === 'human_verified') {
    return {
      ...existingRecord,
      suggested_value: fieldData.value,
      suggested_confidence: fieldData.confidence,
    };
  }

  const rawValue = fieldData.value !== undefined ? fieldData.value : null;
  const evidence = fieldData.evidence ? String(fieldData.evidence).trim() : null;
  const timestamp = fieldData.timestamp ? String(fieldData.timestamp).trim() : null;
  let confidence = typeof fieldData.confidence === 'number' ? fieldData.confidence : 0.0;

  // If field is explicitly null or empty
  if (rawValue === null || rawValue === '' || String(rawValue).toLowerCase() === 'null') {
    return {
      value: null,
      evidence: null,
      timestamp: null,
      confidence: 0,
      needs_review: false,
    };
  }

  // 1. Evidence existence and token overlap check
  if (!evidence) {
    return {
      value: null,
      evidence: null,
      timestamp,
      confidence: 0,
      needs_review: true,
      reason: 'evidence_not_found',
    };
  }

  const overlap = computeTokenOverlap(evidence, fullTranscript);
  if (overlap < 0.85) {
    // Fabricated or unlocatable quote -> reject completely
    return {
      value: null,
      evidence,
      timestamp,
      confidence: 0,
      needs_review: true,
      reason: 'evidence_not_found',
    };
  }

  // 2. Specific format validation for email & phone
  if (fieldName.includes('email')) {
    if (!isValidEmail(rawValue)) {
      return {
        value: null,
        evidence,
        timestamp,
        confidence: 0,
        needs_review: true,
        reason: 'invalid_email_format',
      };
    }
  }

  if (fieldName.includes('phone')) {
    if (!isValidPhone(rawValue)) {
      return {
        value: null,
        evidence,
        timestamp,
        confidence: 0,
        needs_review: true,
        reason: 'invalid_phone_format',
      };
    }
  }

  // 3. Confidence threshold check (< 0.6 flags needs_review)
  const needsReview = confidence < 0.6;

  return {
    value: rawValue,
    evidence,
    timestamp,
    confidence,
    needs_review: needsReview,
  };
}

/**
 * Validates full extraction payload against call transcript
 */
export function validateCallAnalysis(rawAnalysis = {}, transcript = '', existingExtractions = {}) {
  const validated = {
    call_quality: rawAnalysis.call_quality || { usable: true, language_detected: 'hinglish', reason: null },
    call_summary: rawAnalysis.call_summary || { summary: null, outcome: 'no_clear_outcome' },
    contact_person: {},
    sales_intelligence: {},
    objections: Array.isArray(rawAnalysis.objections) ? rawAnalysis.objections : [],
    action_items: Array.isArray(rawAnalysis.action_items) ? rawAnalysis.action_items : [],
  };

  // If call is flagged unusable
  if (!validated.call_quality.usable) {
    return {
      ...validated,
      contact_person: {
        contact_name: { value: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        designation: { value: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        department: { value: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        company_headcount: { value: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        phone: { value: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        email: { value: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        seniority: { value: 'unknown', evidence: null, timestamp: null, confidence: 0, needs_review: false },
        decision_authority: { value: 'unknown', evidence: null, timestamp: null, confidence: 0, needs_review: false },
      },
      sales_intelligence: {
        client_requirement: { value: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        main_problem: { value: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        current_vendor: { value: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        budget: { value: null, amount_inr: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
        lead_temperature: { value: 'unknown', confidence: 0, needs_review: false },
        temperature_signals: [],
        next_followup: { action: null, datetime_iso: null, raw_phrase: null, evidence: null, timestamp: null, confidence: 0, needs_review: false },
      },
    };
  }

  // Validate Contact Person fields
  const rawCP = rawAnalysis.contact_person || {};
  const contactFields = ['contact_name', 'designation', 'department', 'company_headcount', 'phone', 'email', 'seniority', 'decision_authority'];
  for (const f of contactFields) {
    validated.contact_person[f] = validateEvidenceField(
      f,
      rawCP[f],
      transcript,
      existingExtractions[f],
    );
  }

  // Validate Sales Intelligence fields
  const rawSI = rawAnalysis.sales_intelligence || {};
  const salesFields = ['client_requirement', 'main_problem', 'current_vendor'];
  for (const f of salesFields) {
    validated.sales_intelligence[f] = validateEvidenceField(
      f,
      rawSI[f],
      transcript,
      existingExtractions[f],
    );
  }

  // Validate budget
  const rawBudget = rawSI.budget || {};
  const validatedBudget = validateEvidenceField('budget', rawBudget, transcript, existingExtractions.budget);
  validated.sales_intelligence.budget = {
    ...validatedBudget,
    amount_inr: validatedBudget.value ? (typeof rawBudget.amount_inr === 'number' ? rawBudget.amount_inr : null) : null,
  };

  // Validate lead_temperature & signals
  const rawTemp = rawSI.lead_temperature || {};
  const tempConfidence = typeof rawTemp.confidence === 'number' ? rawTemp.confidence : 0.5;
  validated.sales_intelligence.lead_temperature = {
    value: rawTemp.value || 'unknown',
    confidence: tempConfidence,
    needs_review: tempConfidence < 0.6,
  };
  validated.sales_intelligence.temperature_signals = Array.isArray(rawSI.temperature_signals)
    ? rawSI.temperature_signals
    : [];

  // Validate next_followup
  const rawNF = rawSI.next_followup || {};
  const nfValue = rawNF.value !== undefined ? rawNF.value : (rawNF.action || rawNF.raw_phrase || null);
  const validatedNF = validateEvidenceField('next_followup', { ...rawNF, value: nfValue }, transcript, existingExtractions.next_followup);
  validated.sales_intelligence.next_followup = {
    ...validatedNF,
    action: validatedNF.value ? rawNF.action || 'Call' : null,
    datetime_iso: validatedNF.value ? rawNF.datetime_iso || null : null,
    raw_phrase: validatedNF.value ? rawNF.raw_phrase || null : null,
  };

  return validated;
}
