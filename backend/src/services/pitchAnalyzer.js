import {
  all,
  createRoleplaySession,
  get,
  getCallById,
  getCallTrainingCoverage,
  getLeadById,
  getRoleplaySessionById,
  listCalls,
  listLeads,
  listPitchEvaluations,
  listPlaybookRules,
  listWhatsAppMessages,
  resolveUnifiedExecutive,
  updateRoleplaySession,
  upsertPitchEvaluation,
} from '../db.js';
import { buildKnowledgeContextBlock } from './knowledgeBase.js';

export const ROLEPLAY_SCENARIOS = [
  {
    id: 'price-negotiator',
    title: 'Pharma Procurement Head — Rate Negotiation',
    difficulty: 'Hard',
    personaPrompt:
      'You are Mr. Gupta, Procurement Head at a large Indian pharmaceutical company (PIBO, ~120 MT/year Category II plastic). You speak natural Hinglish. Your main objection is that Climeto per-MT credit rate is higher than a cheaper local recycler. Only soften if the executive asks your exact waste category/MT volume and explains CPCB audit safety & verified certificates.',
    openingMessage:
      'Hello ji, aapka quotation dekha maine. Frankly bolun to aapka per-MT rate hamare current recycler se kaafi zyada hai. Kam kar sakte ho to baat karein.',
  },
  {
    id: 'busy-owner',
    title: 'Busy Factory Owner — "WhatsApp Kar Do"',
    difficulty: 'Medium',
    personaPrompt:
      'You are Rajesh Sharma, owner of a plastics manufacturing plant in Gujarat. You are busy on the shop floor, speak brief Hinglish, and try to brush off sales calls by saying "abhi time nahi hai, WhatsApp pe details bhej do". Only engage if the executive asks a crisp 20-second discovery question (category/MT volume) and locks a specific follow-up slot.',
    openingMessage:
      'Haan ji boliye, main abhi plant floor pe busy hoon. Jo bhi details hain WhatsApp kar dijiye, baad me dekh lunga.',
  },
  {
    id: 'existing-vendor',
    title: 'Compliance Manager — Already Has Existing Vendor',
    difficulty: 'Medium',
    personaPrompt:
      'You are Neha Mehta, EHS & Compliance Manager at an FMCG brand. You already work with an existing EPR PRO vendor and see no immediate reason to switch. Respond positively only if the executive positions Climeto as a backup/secondary CPCB-verified partner or offers a transparent comparison quote for upcoming deadlines.',
    openingMessage:
      'Thanks for calling, but hum already pichle 2 saal se ek PRO vendor ke sath EPR filing kar rahe hain. Abhi switch karne ka koi plan nahi hai.',
  },
  {
    id: 'skeptical-compliance',
    title: 'First-Time PIBO — Skeptical About CPCB Credits',
    difficulty: 'Easy',
    personaPrompt:
      'You are Amit Patel, Director at a mid-size packaging importer (~40 MT/year). You recently got a CPCB notice/reminder and are confused about Category I/II/III credits and worried about fake certificates. Warm up if the executive explains EPR compliance clearly and asks your category and MT volume.',
    openingMessage:
      'Dekhiye hume CPCB portal pe EPR target dikh raha hai, par market me sab alag-alag rate bol rahe hain. Aapke credits genuine honge iski kya guarantee hai?',
  },
];

function getGeminiConfig() {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const model = String(process.env.GEMINI_MODEL || 'gemini-flash-lite-latest').trim();
  const useLiveAi = Boolean(apiKey) && process.env.NODE_ENV !== 'test';
  return { apiKey, model, useLiveAi };
}

function extractJsonFromText(text = '') {
  const cleaned = String(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini({ systemPrompt, userPrompt, jsonMode = true }) {
  const { apiKey, model, useLiveAi } = getGeminiConfig();
  if (!useLiveAi) {
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: jsonMode ? 0.25 : 0.65,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };

  let res;
  let lastErrText = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify(body),
    });

    if (res.ok) break;
    lastErrText = await res.text();
    if (res.status === 429 && attempt < 2) {
      await sleep(2500 * (attempt + 1));
      continue;
    }
    throw new Error(`Gemini API ${res.status}: ${lastErrText.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) {
    throw new Error('Gemini returned empty response');
  }

  return {
    text,
    model,
    parsed: jsonMode ? extractJsonFromText(text) : null,
  };
}

function buildPlaybookPromptBlock() {
  const rules = listPlaybookRules({ activeOnly: true });
  const grouped = rules
    .map((r) => `- [${r.category.toUpperCase()}] ${r.title} (Cue: ${r.client_cue || 'General'}) => ${r.ideal_response}`)
    .join('\n');

  // Dynamic Few-Shot Learning: include up to 5 manager-approved evaluations
  const approvedExamples = listPitchEvaluations({ limit: 50 })
    .filter((e) => e.manager_status === 'approved' || e.manager_status === 'edited')
    .slice(0, 5);

  const fewShotBlock = approvedExamples.length
    ? `\n\nMANAGER-CALIBRATED EXAMPLES (follow this scoring bar & tone):\n` +
      approvedExamples
        .map(
          (ex) =>
            `- Score ${ex.manager_score ?? ex.overall_score}/10 | Client: ${ex.client_name} | Better Line: "${ex.manager_try_line || ex.try_line}" | Manager Note: ${ex.manager_note || 'Approved'}`,
        )
        .join('\n')
    : '';

  const knowledgeBlock = buildKnowledgeContextBlock({ maxChars: 6500 });
  return `CLIMETO EPR & PLASTIC CREDITS SALES PLAYBOOK:\n${grouped}${fewShotBlock}${knowledgeBlock}`;
}

function deterministicFallbackEvaluation(transcriptText = '', { clientName, executiveName }) {
  const lower = String(transcriptText).toLowerCase();
  const askedCategory = /category|cat[\s-]?[123]|rigid|flexible|mlp/.test(lower);
  const askedVolume = /\bmt\b|ton|volume|quantity|target/.test(lower);
  const mentionedCpcb = /cpcb|epr|certificate|compliance|credit/.test(lower);
  const lockedNextStep = /tomorrow|kal|am|pm|baje|follow[\s-]?up|quotation|quote|brochure/.test(lower);

  const opener = lower.includes('climeto') || lower.includes('namaste') || lower.includes('hello') ? 7.5 : 5.5;
  const discovery = (askedCategory ? 4.5 : 2) + (askedVolume ? 4.5 : 2);
  const valuePitch = mentionedCpcb ? 8 : 5;
  const objectionHandling = lower.includes('busy') || lower.includes('rate') || lower.includes('baad') ? 6 : 7;
  const closing = lockedNextStep ? 8 : 4.5;
  const followup = lower.includes('whatsapp') || lower.includes('email') || lower.includes('quote') ? 7.5 : 5.5;
  const overall = Number(((opener + discovery + valuePitch + objectionHandling + closing + followup) / 6).toFixed(1));

  const strengths = [];
  const gaps = [];
  const missedQuestions = [];
  const redFlags = [];

  if (mentionedCpcb) strengths.push('Clearly referenced Climeto EPR / CPCB compliance value.');
  if (lockedNextStep) strengths.push('Attempted to lock a concrete follow-up or quotation step.');
  if (strengths.length === 0) strengths.push('Initiated prospect outreach politely.');

  if (!askedCategory) {
    gaps.push('Did not confirm Plastic Waste Category (Category I, II, or III).');
    missedQuestions.push('Aapka plastic packaging kis category me aata hai (Category I, II, ya III)?');
  }
  if (!askedVolume) {
    gaps.push('Did not uncover annual/monthly EPR volume in MT before quoting.');
    missedQuestions.push('Aapka annual EPR target approx kitne Metric Tons (MT) ka hai?');
  }
  if (!lockedNextStep) {
    gaps.push('Ended conversation without locking a specific callback date and time.');
    redFlags.push('No confirmed next follow-up time locked with the client.');
  }

  return {
    overall_score: overall,
    scores: {
      opener,
      discovery,
      value_pitch: valuePitch,
      objection_handling: objectionHandling,
      closing,
      followup,
    },
    strengths,
    gaps,
    missed_questions: missedQuestions,
    red_flags: redFlags,
    try_line: !askedVolume
      ? 'Sir, accurate commercial slab ke liye bas apni waste category (I/II/III) aur approx annual MT volume bata dijiye — main aaj hi best CPCB-verified quote bhej deta hoon.'
      : 'Main abhi WhatsApp par CPCB specimen certificate aur slab quote bhej raha hoon — kya hum kal subah 11:30 AM par 2-minute review call rakhein?',
    ai_summary: `${executiveName} engaged ${clientName}. ${gaps.length ? gaps[0] : 'Good discovery and follow-up alignment.'}`,
    model_used: 'playbook-heuristic',
  };
}

export async function evaluateCallPitch(callId) {
  const call = getCallById(callId);
  if (!call) throw new Error('Call not found');

  const waMessages = call.lead_id ? listWhatsAppMessages({ leadId: call.lead_id, limit: 15 }) : [];
  const waText = waMessages
    .map((m) => `[WhatsApp ${m.direction} @ ${m.timestamp}] ${m.message}`)
    .join('\n');

  const channelSummary = [
    `CALL TRANSCRIPT (${call.direction || 'Outgoing'}, ${call.duration_seconds || 0}s):`,
    call.transcript || call.summary || 'No transcript available',
    call.promise ? `PROMISE MADE: ${call.promise}` : '',
    call.next_action ? `NEXT ACTION: ${call.next_action}` : '',
    waText ? `\nRELATED WHATSAPP MESSAGES:\n${waText}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const playbookContext = buildPlaybookPromptBlock();
  const systemPrompt = `You are Climeto's Senior Sales Intelligence Coach for EPR & Plastic Credits in India.
Evaluate the executive's sales pitch strictly against the Climeto Playbook below.
Return ONLY valid JSON with this exact schema:
{
  "overall_score": number (0-10, 1 decimal),
  "scores": {
    "opener": number (0-10),
    "discovery": number (0-10),
    "value_pitch": number (0-10),
    "objection_handling": number (0-10),
    "closing": number (0-10),
    "followup": number (0-10)
  },
  "strengths": ["short bullet 1", "short bullet 2"],
  "gaps": ["specific gap 1", "specific gap 2"],
  "missed_questions": ["exact question executive should have asked"],
  "red_flags": ["compliance, pricing, or broken-promise red flag if any"],
  "try_line": "One exact natural Hinglish/English line the executive should say next time",
  "ai_summary": "Crisp 2-sentence coaching verdict"
}

${playbookContext}`;

  const userPrompt = `Executive: ${call.executive_name}\nClient: ${call.client_name} (${call.client_phone})\n\n${channelSummary}`;

  let result;
  try {
    const ai = await callGemini({ systemPrompt, userPrompt, jsonMode: true });
    if (ai?.parsed) {
      result = { ...ai.parsed, model_used: ai.model };
    } else {
      result = deterministicFallbackEvaluation(channelSummary, {
        clientName: call.client_name,
        executiveName: call.executive_name,
      });
    }
  } catch (err) {
    console.warn('[PitchAnalyzer] Gemini fallback for call', callId, ':', err.message);
    result = deterministicFallbackEvaluation(channelSummary, {
      clientName: call.client_name,
      executiveName: call.executive_name,
    });
  }

  const resolvedExec = resolveUnifiedExecutive(call.executive_name);
  return upsertPitchEvaluation({
    target_type: 'call',
    target_id: call.id,
    lead_id: call.lead_id,
    executive_name: resolvedExec.canonicalName,
    client_name: call.client_name,
    channel_summary: channelSummary,
    ...result,
  });
}

export async function evaluateLeadPitch(leadId) {
  const detail = getLeadById(leadId);
  if (!detail?.lead) throw new Error('Lead not found');

  const lead = detail.lead;
  const calls = detail.calls || [];
  const waMessages = listWhatsAppMessages({ leadId: lead.id, limit: 25 });
  const emails = all('SELECT * FROM zoho_emails WHERE lead_id = ? ORDER BY sent_at DESC LIMIT 10', [lead.id]);
  const campaigns = all('SELECT * FROM campaign_events WHERE lead_id = ? ORDER BY occurred_at DESC LIMIT 10', [lead.id]);
  const zohoAccount = lead.company
    ? all('SELECT account_name, industry, owner_name FROM zoho_accounts WHERE account_name LIKE ? LIMIT 1', [`%${lead.company}%`])[0]
    : null;

  const rawExecutiveName =
    calls[0]?.executive_name ||
    waMessages[0]?.executive_name ||
    emails[0]?.executive_name ||
    zohoAccount?.owner_name ||
    'Sales Executive';
  const resolvedExec = resolveUnifiedExecutive(rawExecutiveName);
  const executiveName = resolvedExec.canonicalName;

  const channelSummary = [
    `LEAD 360: ${lead.client_name} (${lead.client_phone || ''}) | Stage: ${lead.stage || 'Contacted'} | Hotness: ${lead.hotness || 'warm'}${zohoAccount ? ` | Zoho Account: ${zohoAccount.account_name} (${zohoAccount.industry || 'Industry N/A'})` : ''}`,
    campaigns.length
      ? `\nMANYREACH CAMPAIGNS (${campaigns.length}):\n` +
        campaigns.slice(0, 5).map((c) => `- [${c.event_type}] ${c.title}: ${c.description || ''}`).join('\n')
      : '',
    calls.length
      ? `\nCALLS (${calls.length}):\n` +
        calls.slice(0, 3).map((c) => `- [${c.created_at}] ${c.executive_name}: ${c.transcript || c.summary}`).join('\n')
      : '',
    waMessages.length
      ? `\nWHATSAPP CHATS (${waMessages.length}):\n` +
        waMessages.map((m) => `- [${m.direction}] ${m.message}`).join('\n')
      : '',
    emails.length
      ? `\nZOHO EMAILS (${emails.length}):\n` +
        emails.map((e) => `- [${e.direction}] ${e.subject}: ${e.summary || e.body_snippet}`).join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const playbookContext = buildPlaybookPromptBlock();
  const systemPrompt = `You are Climeto's Senior Sales Intelligence Coach for EPR & Plastic Credits in India.
Evaluate this unified 6-channel lead journey (Manyreach Campaigns + Calls + WhatsApp + Zoho Emails + Zoho CRM Stage) strictly against the Climeto Playbook.
Return ONLY valid JSON with this exact schema:
{
  "overall_score": number (0-10, 1 decimal),
  "scores": {
    "opener": number (0-10),
    "discovery": number (0-10),
    "value_pitch": number (0-10),
    "objection_handling": number (0-10),
    "closing": number (0-10),
    "followup": number (0-10)
  },
  "strengths": ["short bullet 1"],
  "gaps": ["specific gap 1"],
  "missed_questions": ["exact question executive should ask next"],
  "red_flags": ["any compliance/follow-up red flag"],
  "try_line": "Exact natural Hinglish/English message or line the executive should send next",
  "ai_summary": "Crisp 2-sentence multi-channel coaching verdict"
}

${playbookContext}`;

  let result;
  try {
    const ai = await callGemini({ systemPrompt, userPrompt: channelSummary, jsonMode: true });
    if (ai?.parsed) {
      result = { ...ai.parsed, model_used: ai.model };
    } else {
      result = deterministicFallbackEvaluation(channelSummary, {
        clientName: lead.client_name,
        executiveName,
      });
    }
  } catch (err) {
    console.warn('[PitchAnalyzer] Gemini fallback for lead', leadId, ':', err.message);
    result = deterministicFallbackEvaluation(channelSummary, {
      clientName: lead.client_name,
      executiveName,
    });
  }

  return upsertPitchEvaluation({
    target_type: 'lead',
    target_id: lead.id,
    lead_id: lead.id,
    executive_name: executiveName,
    client_name: lead.client_name,
    channel_summary: channelSummary,
    ...result,
  });
}

export async function evaluateRecentBatch({ limit = 4 } = {}) {
  const existing = listPitchEvaluations({ limit: 2000 });
  const scoredCalls = new Set(existing.filter((e) => e.target_type === 'call').map((e) => e.target_id));
  const scoredLeads = new Set(existing.filter((e) => e.target_type === 'lead').map((e) => e.target_id));

  const callQuota = Math.ceil(limit / 2);
  const waQuota = Math.floor(limit / 2);
  const evaluated = [];

  // 1. Evaluate WhatsApp-active leads (covers all linked WhatsApp work SIM executives)
  const leads = listLeads();
  const pendingWaLeads = [];
  for (const lead of leads) {
    if (scoredLeads.has(lead.id)) continue;
    const wa = listWhatsAppMessages({ leadId: lead.id, limit: 1 });
    if (wa.length > 0) pendingWaLeads.push(lead);
  }

  for (const lead of pendingWaLeads.slice(0, waQuota)) {
    evaluated.push(await evaluateLeadPitch(lead.id));
  }

  // 2. Evaluate Calls
  const pendingCalls = listCalls({}).filter((c) => !scoredCalls.has(c.id));
  for (const call of pendingCalls.slice(0, callQuota)) {
    if (evaluated.length >= limit) break;
    evaluated.push(await evaluateCallPitch(call.id));
  }

  // 3. Fill any remaining slots from either pool
  for (const lead of pendingWaLeads.slice(waQuota)) {
    if (evaluated.length >= limit) break;
    evaluated.push(await evaluateLeadPitch(lead.id));
  }
  for (const call of pendingCalls.slice(callQuota)) {
    if (evaluated.length >= limit) break;
    evaluated.push(await evaluateCallPitch(call.id));
  }

  return { evaluated_count: evaluated.length, evaluations: evaluated };
}

// ============================================================
// Dual-Lane Call Pitch Training Worker
// Lane 1 (High Priority): Live auto-training on every new completed call
// Lane 2 (Background): Historical backfill for 100+ older calls
// ============================================================

let trainingEventEmitter = null;
let autoTrainEnabled =
  String(process.env.AUTO_PITCH_TRAINING_ON_NEW_CALL ?? 'true').toLowerCase() !== 'false';
let workerLoopActive = false;
let backfillDelayMs = process.env.NODE_ENV === 'test' ? 0 : 1500;

const liveCallQueue = [];
const backfillCallQueue = [];

const backfillState = {
  running: false,
  stop_requested: false,
  target_count: 100,
  processed: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  live_processed: 0,
  current_call: null,
  started_at: null,
  finished_at: null,
  last_evaluated_at: null,
  last_error: null,
};

export function setTrainingEventEmitter(fn) {
  trainingEventEmitter = typeof fn === 'function' ? fn : null;
}

function emitTrainingEvent(type, payload) {
  try {
    trainingEventEmitter?.(type, payload);
  } catch {
    // Ignore SSE broadcast errors
  }
}

function isCallAlreadyEvaluated(callId) {
  const row = get(
    "SELECT id FROM pitch_evaluations WHERE target_type = 'call' AND target_id = ?",
    [callId],
  );
  return Boolean(row);
}

function hasRealTranscript(call) {
  const t = String(call?.transcript || '').trim().toLowerCase();
  return Boolean(t && t !== 'transcript pending.' && t !== 'no transcript available' && t.length > 15);
}

export function setAutoTrainEnabled(enabled) {
  autoTrainEnabled = Boolean(enabled);
  const status = getTrainingJobStatus();
  emitTrainingEvent('training.progress', status);
  return status;
}

export function getTrainingJobStatus() {
  return {
    running: backfillState.running,
    worker_active: workerLoopActive,
    auto_train_enabled: autoTrainEnabled,
    target_count: backfillState.target_count,
    processed: backfillState.processed,
    succeeded: backfillState.succeeded,
    failed: backfillState.failed,
    skipped: backfillState.skipped,
    live_processed: backfillState.live_processed,
    live_queue_size: liveCallQueue.length,
    backfill_remaining: backfillCallQueue.length,
    current_call: backfillState.current_call,
    started_at: backfillState.started_at,
    finished_at: backfillState.finished_at,
    last_evaluated_at: backfillState.last_evaluated_at,
    last_error: backfillState.last_error,
    call_coverage: getCallTrainingCoverage(),
  };
}

async function runDualLaneWorker() {
  if (workerLoopActive) return;
  workerLoopActive = true;

  try {
    while (liveCallQueue.length > 0 || (backfillState.running && !backfillState.stop_requested && backfillCallQueue.length > 0)) {
      // Lane 1 (High Priority): Always process new live calls first!
      const isLive = liveCallQueue.length > 0;
      const item = isLive ? liveCallQueue.shift() : backfillCallQueue.shift();
      if (!item) continue;

      const call = getCallById(item.callId);
      if (!call) {
        if (!isLive) {
          backfillState.skipped += 1;
          backfillState.processed += 1;
        }
        continue;
      }

      if (!item.force && isCallAlreadyEvaluated(call.id)) {
        if (!isLive) {
          backfillState.skipped += 1;
          backfillState.processed += 1;
        }
        continue;
      }

      backfillState.current_call = {
        id: call.id,
        client_name: call.client_name,
        executive_name: call.executive_name,
        lane: isLive ? 'live' : 'backfill',
      };
      emitTrainingEvent('training.progress', getTrainingJobStatus());

      try {
        const evaluation = await evaluateCallPitch(call.id);
        const now = new Date().toISOString();
        backfillState.last_evaluated_at = now;
        backfillState.last_error = null;
        if (isLive) {
          backfillState.live_processed += 1;
        } else {
          backfillState.succeeded += 1;
          backfillState.processed += 1;
        }
        emitTrainingEvent('pitch.evaluated', {
          lane: isLive ? 'live' : 'backfill',
          evaluation_id: evaluation.id,
          call_id: call.id,
          executive_name: evaluation.executive_name,
          client_name: evaluation.client_name,
          overall_score: evaluation.overall_score,
        });
      } catch (err) {
        backfillState.last_error = err.message || String(err);
        if (!isLive) {
          backfillState.failed += 1;
          backfillState.processed += 1;
        }
        console.warn(`[PitchTrainer] ${isLive ? 'Live' : 'Backfill'} evaluation failed for call ${call.id}:`, err.message);
      }

      backfillState.current_call = null;
      emitTrainingEvent('training.progress', getTrainingJobStatus());

      // Pace Gemini requests to avoid RPM rate-limit spikes
      const hasMore =
        liveCallQueue.length > 0 ||
        (backfillState.running && !backfillState.stop_requested && backfillCallQueue.length > 0);
      if (hasMore && backfillDelayMs > 0) {
        await sleep(backfillDelayMs);
      }
    }

    if (backfillState.running) {
      backfillState.running = false;
      backfillState.finished_at = new Date().toISOString();
      backfillState.current_call = null;
      emitTrainingEvent('training.progress', getTrainingJobStatus());
    }
  } finally {
    workerLoopActive = false;
  }
}

export function enqueueLiveCallEvaluation(callId, { force = false } = {}) {
  const cleanId = String(callId || '').trim();
  if (!cleanId) return { queued: false, reason: 'missing_call_id' };
  if (!autoTrainEnabled && !force) {
    return { queued: false, reason: 'auto_train_disabled' };
  }
  if (!force && isCallAlreadyEvaluated(cleanId)) {
    return { queued: false, reason: 'already_evaluated' };
  }
  if (liveCallQueue.some((i) => i.callId === cleanId)) {
    return { queued: false, reason: 'already_queued' };
  }

  // Remove from backfill queue if present so it runs immediately in the high-priority live lane
  const idx = backfillCallQueue.findIndex((i) => i.callId === cleanId);
  if (idx !== -1) backfillCallQueue.splice(idx, 1);

  liveCallQueue.push({ callId: cleanId, force, queuedAt: new Date().toISOString() });
  void runDualLaneWorker();
  return { queued: true, lane: 'live', live_queue_size: liveCallQueue.length };
}

export function startHistoricalCallBackfill({ targetCount = 100, delayMs } = {}) {
  const safeTarget = Math.min(Math.max(Number(targetCount || 100), 1), 500);
  if (typeof delayMs === 'number' && delayMs >= 0) {
    backfillDelayMs = delayMs;
  } else {
    backfillDelayMs = process.env.NODE_ENV === 'test' ? 0 : 1500;
  }

  if (backfillState.running) {
    return getTrainingJobStatus();
  }

  const existingIds = new Set(
    all("SELECT target_id FROM pitch_evaluations WHERE target_type = 'call'").map((r) => r.target_id),
  );

  // Prioritize unscored calls that have real transcripts first, then remaining unscored calls
  const allCalls = listCalls({});
  const unscored = allCalls.filter((c) => !existingIds.has(c.id));
  const prioritized = [
    ...unscored.filter((c) => hasRealTranscript(c)),
    ...unscored.filter((c) => !hasRealTranscript(c)),
  ].slice(0, safeTarget);

  backfillCallQueue.length = 0;
  for (const call of prioritized) {
    backfillCallQueue.push({ callId: call.id, force: false });
  }

  backfillState.target_count = prioritized.length;
  backfillState.processed = 0;
  backfillState.succeeded = 0;
  backfillState.failed = 0;
  backfillState.skipped = 0;
  backfillState.current_call = null;
  backfillState.last_error = null;
  backfillState.stop_requested = false;
  backfillState.started_at = new Date().toISOString();
  backfillState.finished_at = null;
  backfillState.running = prioritized.length > 0;

  if (!backfillState.running) {
    backfillState.finished_at = new Date().toISOString();
  } else {
    void runDualLaneWorker();
  }

  const status = getTrainingJobStatus();
  emitTrainingEvent('training.progress', status);
  return status;
}

export function stopHistoricalCallBackfill() {
  backfillState.stop_requested = true;
  backfillCallQueue.length = 0;
  backfillState.running = false;
  backfillState.finished_at = new Date().toISOString();
  const status = getTrainingJobStatus();
  emitTrainingEvent('training.progress', status);
  return status;
}

export async function suggestBestReply(leadId, { channel = 'whatsapp' } = {}) {
  const detail = getLeadById(leadId);
  if (!detail?.lead) throw new Error('Lead not found');

  const lead = detail.lead;
  const calls = (detail.calls || []).slice(0, 3);
  const waMessages = listWhatsAppMessages({ leadId: lead.id, limit: 15 });
  const playbookContext = buildPlaybookPromptBlock();

  const history = [
    `Lead: ${lead.client_name} (${lead.client_phone || ''}) | Stage: ${lead.stage} | Summary: ${lead.latest_summary || ''}`,
    calls.length ? `Recent Calls:\n${calls.map((c) => `- ${c.summary || c.transcript}`).join('\n')}` : '',
    waMessages.length
      ? `Recent WhatsApp:\n${waMessages.map((m) => `- [${m.direction}] ${m.message}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const systemPrompt = `You are Climeto's Sales Assistant for EPR & Plastic Credits in India.
Based on the lead's history and Climeto Playbook, draft the single best next ${channel === 'call' ? 'Call Opening Script' : 'WhatsApp Reply Message'} in polite, crisp Indian business Hinglish/English.
Return ONLY valid JSON:
{
  "suggested_message": "Ready-to-send message or call opener",
  "pitch_angle": "1-sentence strategy explaining why this works",
  "questions_to_ask": ["question 1", "question 2"]
}

${playbookContext}`;

  try {
    const ai = await callGemini({ systemPrompt, userPrompt: history, jsonMode: true });
    if (ai?.parsed) {
      return { ...ai.parsed, channel, lead_id: lead.id, model_used: ai.model };
    }
  } catch (err) {
    console.warn('[PitchAnalyzer] Suggest reply fallback:', err.message);
  }

  return {
    suggested_message: `Hello ${lead.client_name} ji, following up from Climeto regarding your EPR Plastic Credits requirement. Could you confirm your plastic waste category (I/II/III) and approx annual MT volume so I can share our best CPCB-verified commercial quotation today?`,
    pitch_angle: 'Qualify exact Category and MT volume before quoting to avoid blind price negotiation.',
    questions_to_ask: [
      'Plastic waste category (Category I, II, or III)?',
      'Approx annual EPR target in Metric Tons (MT)?',
    ],
    channel,
    lead_id: lead.id,
    model_used: 'playbook-heuristic',
  };
}

export function startRoleplay({ executiveName = 'Sales Executive', scenarioId = 'price-negotiator' } = {}) {
  const scenario = ROLEPLAY_SCENARIOS.find((s) => s.id === scenarioId) || ROLEPLAY_SCENARIOS[0];
  return createRoleplaySession({
    executiveName,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    personaPrompt: scenario.personaPrompt,
    openingMessage: scenario.openingMessage,
  });
}

export async function replyToRoleplay(sessionId, executiveMessage) {
  const session = getRoleplaySessionById(sessionId);
  if (!session) throw new Error('Roleplay session not found');
  const cleanMsg = String(executiveMessage || '').trim();
  if (!cleanMsg) throw new Error('Message is required');

  const updatedMessages = [
    ...session.messages,
    { role: 'executive', text: cleanMsg, timestamp: new Date().toISOString() },
  ];

  const transcript = updatedMessages
    .map((m) => `${m.role === 'prospect' ? 'Client' : 'Executive'}: ${m.text}`)
    .join('\n');

  let prospectReply = '';
  try {
    const ai = await callGemini({
      systemPrompt: `${session.personaPrompt}\nRespond ONLY as the Indian client in 1–3 realistic sentences (Hinglish/English). Stay in character.`,
      userPrompt: `Conversation so far:\n${transcript}\n\nRespond as the Client:`,
      jsonMode: false,
    });
    prospectReply = ai?.text?.trim() || '';
  } catch (err) {
    console.warn('[Roleplay] Gemini fallback:', err.message);
  }

  if (!prospectReply) {
    const lower = cleanMsg.toLowerCase();
    if (/category|mt|volume|cpcb|audit|certificate/.test(lower)) {
      prospectReply =
        'Haan, hamara approx 80 MT Category II flexible plastic hai. Agar CPCB verified certificate aur proper filing support milega to quotation bhej dijiye.';
    } else {
      prospectReply =
        'Dekhiye rate ki baat pehle clear kariye — doosra vendor sasta de raha hai, aapka extra value kya hai?';
    }
  }

  updatedMessages.push({ role: 'prospect', text: prospectReply, timestamp: new Date().toISOString() });
  return updateRoleplaySession(sessionId, { messages: updatedMessages });
}

export async function finishAndScoreRoleplay(sessionId) {
  const session = getRoleplaySessionById(sessionId);
  if (!session) throw new Error('Roleplay session not found');

  const transcript = session.messages
    .map((m) => `${m.role === 'prospect' ? 'Client' : 'Executive'}: ${m.text}`)
    .join('\n');

  const playbookContext = buildPlaybookPromptBlock();
  const systemPrompt = `You are Climeto's Sales Coach scoring a roleplay practice drill.
Return ONLY valid JSON:
{
  "overall_score": number (0-10, 1 decimal),
  "strengths": ["strength 1"],
  "improvements": ["improvement 1"],
  "best_rebuttal": "Exact Hinglish/English line executive should use in this scenario",
  "verdict": "Crisp 2-sentence coaching summary"
}
${playbookContext}`;

  let score;
  try {
    const ai = await callGemini({
      systemPrompt,
      userPrompt: `Scenario: ${session.scenario_title}\n\nTranscript:\n${transcript}`,
      jsonMode: true,
    });
    score = ai?.parsed || null;
  } catch (err) {
    console.warn('[Roleplay] Score fallback:', err.message);
  }

  if (!score) {
    const fallback = deterministicFallbackEvaluation(transcript, {
      clientName: session.scenario_title,
      executiveName: session.executive_name,
    });
    score = {
      overall_score: fallback.overall_score,
      strengths: fallback.strengths,
      improvements: fallback.gaps,
      best_rebuttal: fallback.try_line,
      verdict: fallback.ai_summary,
    };
  }

  return updateRoleplaySession(sessionId, { score, status: 'completed' });
}

