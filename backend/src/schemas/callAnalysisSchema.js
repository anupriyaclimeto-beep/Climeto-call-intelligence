/**
 * Call Analysis Response Schema for Gemini Structured Output
 * 
 * Defines strict JSON schema for extracting evidence-backed sales facts.
 */

export const Type = {
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  INTEGER: 'INTEGER',
  BOOLEAN: 'BOOLEAN',
  ARRAY: 'ARRAY',
  OBJECT: 'OBJECT',
};

const nullableString = { type: Type.STRING, nullable: true };

const evidenceField = {
  type: Type.OBJECT,
  properties: {
    value: nullableString,
    evidence: nullableString,
    timestamp: nullableString, // "mm:ss"
    confidence: { type: Type.NUMBER },
  },
  required: ['value', 'evidence', 'timestamp', 'confidence'],
};

const enumField = (values) => ({
  type: Type.OBJECT,
  properties: {
    value: { type: Type.STRING, nullable: true, enum: values },
    evidence: nullableString,
    timestamp: nullableString,
    confidence: { type: Type.NUMBER },
  },
  required: ['value', 'evidence', 'timestamp', 'confidence'],
});

const signal = {
  type: Type.OBJECT,
  properties: {
    signal: { type: Type.STRING },
    evidence: { type: Type.STRING },
    timestamp: { type: Type.STRING },
  },
  required: ['signal', 'evidence', 'timestamp'],
};

export const callAnalysisSchema = {
  type: Type.OBJECT,
  properties: {
    call_quality: {
      type: Type.OBJECT,
      properties: {
        usable: { type: Type.BOOLEAN },
        language_detected: { type: Type.STRING, enum: ['hindi', 'english', 'hinglish', 'other'] },
        reason: nullableString,
      },
      required: ['usable', 'language_detected', 'reason'],
    },
    call_summary: {
      type: Type.OBJECT,
      properties: {
        summary: nullableString,
        outcome: {
          type: Type.STRING,
          enum: [
            'meeting_scheduled',
            'follow_up_agreed',
            'quote_requested',
            'not_interested',
            'no_clear_outcome',
            'unusable',
          ],
        },
      },
      required: ['summary', 'outcome'],
    },
    contact_person: {
      type: Type.OBJECT,
      properties: {
        contact_name: evidenceField,
        designation: evidenceField,
        department: evidenceField,
        company_headcount: evidenceField,
        phone: evidenceField,
        email: evidenceField,
        seniority: enumField(['owner_founder', 'c_level', 'head_director', 'manager', 'executive', 'unknown']),
        decision_authority: enumField(['decision_maker', 'influencer', 'gatekeeper', 'unknown']),
      },
      required: ['contact_name', 'designation', 'department', 'company_headcount', 'phone', 'email', 'seniority', 'decision_authority'],
    },
    sales_intelligence: {
      type: Type.OBJECT,
      properties: {
        client_requirement: evidenceField,
        main_problem: evidenceField,
        current_vendor: evidenceField,
        budget: {
          type: Type.OBJECT,
          properties: {
            value: nullableString,
            amount_inr: { type: Type.NUMBER, nullable: true },
            evidence: nullableString,
            timestamp: nullableString,
            confidence: { type: Type.NUMBER },
          },
          required: ['value', 'amount_inr', 'evidence', 'timestamp', 'confidence'],
        },
        lead_temperature: {
          type: Type.OBJECT,
          properties: {
            value: { type: Type.STRING, enum: ['hot', 'warm', 'cold', 'unknown'] },
            confidence: { type: Type.NUMBER },
          },
          required: ['value', 'confidence'],
        },
        temperature_signals: { type: Type.ARRAY, items: signal },
        next_followup: {
          type: Type.OBJECT,
          properties: {
            action: nullableString,
            datetime_iso: nullableString,
            raw_phrase: nullableString,
            evidence: nullableString,
            timestamp: nullableString,
            confidence: { type: Type.NUMBER },
          },
          required: ['action', 'datetime_iso', 'raw_phrase', 'evidence', 'timestamp', 'confidence'],
        },
      },
      required: [
        'client_requirement',
        'main_problem',
        'current_vendor',
        'budget',
        'lead_temperature',
        'temperature_signals',
        'next_followup',
      ],
    },
    objections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          objection: { type: Type.STRING },
          evidence: { type: Type.STRING },
          timestamp: { type: Type.STRING },
        },
        required: ['objection', 'evidence', 'timestamp'],
      },
    },
    action_items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          owner: { type: Type.STRING, enum: ['bd', 'client'] },
          task: { type: Type.STRING },
          evidence: { type: Type.STRING },
          timestamp: { type: Type.STRING },
        },
        required: ['owner', 'task', 'evidence', 'timestamp'],
      },
    },
  },
  required: ['call_quality', 'call_summary', 'contact_person', 'sales_intelligence', 'objections', 'action_items'],
};
