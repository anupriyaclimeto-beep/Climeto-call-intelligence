/**
 * Call Extractor Service (Gemini Structured Extraction)
 * 
 * Extracts evidence-backed sales facts for Section B (Contact Person)
 * and Section C (Sales Intelligence) from call speech.
 * 
 * Integrates:
 * - callExtraction.txt system prompt
 * - callAnalysisSchema.js response schema
 * - callValidators.js strict validation layer
 * - 1 retry on JSON schema failure
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAnalysisSchema } from '../schemas/callAnalysisSchema.js';
import { validateCallAnalysis } from './callValidators.js';
import { saveBatchCallExtractions } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const promptPath = path.resolve(__dirname, '../prompts/callExtraction.txt');

let cachedSystemPrompt = '';
function getSystemPrompt() {
  if (!cachedSystemPrompt && fs.existsSync(promptPath)) {
    cachedSystemPrompt = fs.readFileSync(promptPath, 'utf8');
  }
  return cachedSystemPrompt || 'You are an expert B2B sales intelligence extractor. Extract only verified facts with exact quotes and timestamps.';
}

export function formatTranscriptUtterances(transcriptInput) {
  if (Array.isArray(transcriptInput)) {
    return transcriptInput
      .map((u) => {
        const sec = typeof u.start_sec === 'number' ? Math.floor(u.start_sec) : 0;
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        const speaker = u.speaker ? `${u.speaker}: ` : '';
        return `[${mm}:${ss}] ${speaker}${u.text}`;
      })
      .join('\n');
  }

  const str = String(transcriptInput || '').trim();
  if (/\[\d{2}:\d{2}\]/.test(str)) {
    return str;
  }

  // Assign progressive approximate timestamps if raw text lacks them
  const lines = str.split('\n').filter((l) => l.trim().length > 0);
  let currentSec = 5;
  return lines
    .map((line) => {
      const mm = String(Math.floor(currentSec / 60)).padStart(2, '0');
      const ss = String(currentSec % 60).padStart(2, '0');
      currentSec += 8;
      return `[${mm}:${ss}] ${line.trim()}`;
    })
    .join('\n');
}

/**
 * Extracts and validates call intelligence using Gemini with 1 retry
 */
export async function extractCallIntelligence({
  transcript = '',
  callDate = null,
  callerNumber = '',
  existingExtractions = {},
} = {}) {
  const formattedTranscript = formatTranscriptUtterances(transcript);

  // If transcript is empty or negligible
  if (!formattedTranscript || formattedTranscript.length < 20) {
    return validateCallAnalysis(
      {
        call_quality: { usable: false, language_detected: 'other', reason: 'Transcript too short or empty' },
      },
      '',
      existingExtractions,
    );
  }

  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const model = String(process.env.GEMINI_MODEL || 'gemini-flash-lite-latest').trim();

  if (!apiKey) {
    // When AI key is unconfigured, return clean unextracted call state
    return validateCallAnalysis(
      {
        call_quality: { usable: true, language_detected: 'hinglish', reason: 'AI key unconfigured' },
      },
      formattedTranscript,
      existingExtractions,
    );
  }

  const systemPrompt = getSystemPrompt();
  const dateStr = callDate ? new Date(callDate).toISOString() : new Date().toISOString();
  const userPrompt = `CALL METADATA:
Call Date: ${dateStr} (Timezone: Asia/Kolkata)
Caller Phone Number: ${callerNumber || 'Not provided'}

CALL TRANSCRIPT:
${formattedTranscript}`;

  let attempts = 0;
  let rawJson = null;
  let lastError = null;

  while (attempts < 2) {
    attempts++;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 18000);

      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: callAnalysisSchema,
          },
        }),
      });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`Gemini API HTTP ${res.status}: ${res.statusText}`);
      }

      const payload = await res.json();
      const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      rawJson = JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
      break;
    } catch (err) {
      lastError = err;
      if (attempts < 2) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  if (!rawJson) {
    throw new Error(`Call analysis failed after 2 attempts: ${lastError?.message || 'unknown'}`);
  }

  // Pass extracted structure through mandatory evidence validation layer
  const validated = validateCallAnalysis(rawJson, formattedTranscript, existingExtractions);
  return validated;
}

/**
 * Convenience helper to extract and persist call intelligence directly in DB
 */
export async function extractAndSaveCallAnalysis({
  callId = '',
  transcript = '',
  callDate = null,
  callerNumber = '',
} = {}) {
  if (!callId || !transcript) return [];
  const validated = await extractCallIntelligence({
    transcript,
    callDate,
    callerNumber,
  });
  return saveBatchCallExtractions(callId, validated, 'gemini');
}
