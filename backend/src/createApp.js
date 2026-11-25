import cors from 'cors';
import express from 'express';
import multer from 'multer';
import {
  createExecutive,
  deleteExecutive,
  deleteKnowledgeDoc,
  deletePlaybookRule,
  exportTrainingJsonl,
  getCallById,
  getClientIntelById,
  getClientIntelByTarget,
  getDashboardData,
  getExecutiveCoachingSummary,
  getLatestWebhookEvent,
  getLeadById,
  getZohoEmailSettings,
  listActivities,
  listCalls,
  listCampaignFeed,
  listClientIntel,
  listExecutives,
  listKnowledgeDocs,
  listLeads,
  listPlaybookRules,
  listRoleplaySessions,
  listWebhookEvents,
  syncClientIntelToZoho,
  saveZohoEmailSettings,
  toggleKnowledgeDoc,
  updatePitchEvaluationFeedback,
  upsertClientIntel,
  upsertPlaybookRule,
  saveCompanySearch,
  getRecentCompanySearches,
  getCachedDossier,
  setCachedDossier,
  saveCallExtraction,
  saveBatchCallExtractions,
  getCallExtractionsByCallId,
  updateCallExtractionField,
} from './db.js';
import { receiveManyreachWebhook } from './services/manyreachWebhook.js';
import { syncManyreachEvents } from './jobs/manyreachSyncSkeleton.js';
import { getZohoSettings } from './services/zohoBridge.js';
import { syncZohoCrm, syncZohoAccounts, getZohoAccountsPayload } from './services/zohoSync.js';
import {
  getZohoEmailsPayload,
  syncZohoEmails,
  receiveZohoEmailWebhook,
} from './services/zohoEmailSync.js';
import {
  getWhatsAppFeedPayload,
  receiveWhatsAppSync,
  simulateWhatsAppMessage,
} from './services/whatsappSync.js';
import {
  getWhatsAppSessionsStatus,
  startExecutiveWhatsAppSession,
  disconnectExecutiveWhatsAppSession,
} from './services/whatsappBridge.js';
import {
  ROLEPLAY_SCENARIOS,
  evaluateCallPitch,
  evaluateLeadPitch,
  evaluateRecentBatch,
  finishAndScoreRoleplay,
  getTrainingJobStatus,
  replyToRoleplay,
  setAutoTrainEnabled,
  startHistoricalCallBackfill,
  startRoleplay,
  stopHistoricalCallBackfill,
  suggestBestReply,
} from './services/pitchAnalyzer.js';
import {
  generatePlaybookRulesFromKnowledge,
  ingestUploadedFiles,
} from './services/knowledgeBase.js';
import { extractClientIntelForCall } from './services/clientIntelExtractor.js';
import { enrichCompanyProfile, lookupVerifiedCompany } from './services/companyIntelEnricher.js';
import { searchByName, getMasterData, getFinancials } from './services/mcaProvider.js';
import { scrapeOfficialWebsite } from './services/websiteScraper.js';
import { classifyIndustry } from './services/industryClassifier.js';
import { mergeSectionA, createUnifiedDossier } from './services/dossierMerge.js';
import { extractCallIntelligence } from './services/callExtractor.js';

const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

function requireManyreachToken(req, res) {
  const expected = process.env.MANYREACH_WEBHOOK_SECRET || '';
  const provided = String(req.query.token || '');

  if (!expected) {
    res.status(503).json({
      success: false,
      message: 'MANYREACH_WEBHOOK_SECRET is not configured',
    });
    return false;
  }

  if (!provided || provided !== expected) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }

  return true;
}

function parseWebhookBody(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return { raw: String(raw), malformed: true };
  }
}

export function createApp({ sendEvent = () => {}, supabaseBridge = null } = {}) {
  const app = express();
  const allowedOrigins = (
    process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean)
      : ['http://localhost:5173', 'http://127.0.0.1:5173']
  );

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('CORS not allowed'));
      },
    }),
  );

  app.post(
    '/api/webhooks/manyreach',
    express.text({ type: '*/*', limit: '2mb' }),
    (req, res) => {
      if (!requireManyreachToken(req, res)) return;

      const parsed = parseWebhookBody(req.body);
      const result = receiveManyreachWebhook(parsed);

      return res.status(200).json({
        success: true,
        data: {
          received: true,
          webhookId: result.webhookId,
          inserted: Boolean(result.inserted),
          duplicate: Boolean(result.duplicate),
        },
      });
    },
  );

  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    return res.json({
      ok: true,
      service: 'climeto-intelligence-workspace',
      database: 'sqlite',
    });
  });

  app.get('/api/dashboard', (_req, res) => {
    return res.json({ success: true, data: getDashboardData() });
  });

  app.get('/api/calls', (req, res) => {
    const data = listCalls({
      search: String(req.query.search || '').trim(),
      platform: String(req.query.platform || '').trim(),
      stage: String(req.query.stage || '').trim(),
    });
    return res.json({ success: true, data });
  });

  app.get('/api/calls/:id', (req, res) => {
    const call = getCallById(req.params.id);
    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' });
    }
    return res.json({ success: true, data: call });
  });

  app.get('/api/leads', (_req, res) => {
    return res.json({ success: true, data: listLeads() });
  });

  app.get('/api/leads/:id', (req, res) => {
    const data = getLeadById(req.params.id);
    if (!data) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    return res.json({ success: true, data });
  });

  app.get('/api/activities', (req, res) => {
    const platform = String(req.query.platform || '').trim();
    return res.json({ success: true, data: listActivities(platform) });
  });

  app.get('/api/campaigns/feed', (req, res) => {
    const limit = Number(req.query.limit || 50);
    const since = String(req.query.since || '').trim();
    const feed = listCampaignFeed({ limit, since });
    return res.json({ success: true, data: feed.items, meta: feed.meta });
  });

  app.all('/api/campaigns/sync', async (_req, res) => {
    try {
      const result = await syncManyreachEvents();
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/webhooks/manyreach/debug', (req, res) => {
    if (!requireManyreachToken(req, res)) return;

    const limit = Number(req.query.limit || 10);
    const latest = getLatestWebhookEvent('manyreach');
    const events = listWebhookEvents({ source: 'manyreach', limit });

    return res.json({
      success: true,
      data: {
        latest,
        events,
        tip: 'Use latest.payload keys to refine normalizeManyreachEvent in manyreachMapper.js',
      },
    });
  });

  app.get('/api/settings/zoho', (_req, res) => {
    return res.json({ success: true, data: getZohoSettings() });
  });

  app.all('/api/settings/zoho/sync', async (_req, res) => {
    try {
      const result = await syncZohoCrm();
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/zoho/accounts', (req, res) => {
    const search = String(req.query.search || '').trim();
    return res.json({ success: true, data: getZohoAccountsPayload({ search }) });
  });

  app.all('/api/zoho/accounts/sync', async (_req, res) => {
    try {
      const result = await syncZohoAccounts();
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/zoho/emails', (req, res) => {
    const filters = {
      executive: String(req.query.executive || '').trim(),
      direction: String(req.query.direction || '').trim(),
      search: String(req.query.search || '').trim(),
      limit: Number(req.query.limit || 50),
    };
    return res.json({ success: true, data: getZohoEmailsPayload(filters) });
  });

  app.get('/api/zoho/emails/settings', (_req, res) => {
    return res.json({ success: true, data: getZohoEmailSettings() });
  });

  app.put('/api/zoho/emails/settings', (req, res) => {
    try {
      const updated = saveZohoEmailSettings({
        trackedEmails: req.body?.trackedEmails,
        hideAutomated: req.body?.hideAutomated,
      });
      return res.json({ success: true, data: updated });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.all('/api/zoho/emails/sync', async (_req, res) => {
    try {
      const result = await syncZohoEmails();
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/webhooks/zoho-emails', (req, res) => {
    try {
      const result = receiveZohoEmailWebhook(req.body);
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.get('/api/whatsapp/messages', (req, res) => {
    const filters = {
      search: String(req.query.search || '').trim(),
      direction: String(req.query.direction || '').trim(),
      executive: String(req.query.executive || '').trim(),
      leadId: String(req.query.leadId || '').trim(),
      phone: String(req.query.phone || '').trim(),
      limit: Number(req.query.limit || 100),
    };
    return res.json({ success: true, data: getWhatsAppFeedPayload(filters) });
  });

  app.post('/api/whatsapp/sync', (req, res) => {
    try {
      const result = receiveWhatsAppSync(req.body);
      sendEvent('whatsapp.received', {
        id: result.message.id,
        lead_id: result.message.lead_id,
        client_name: result.message.client_name,
        client_phone: result.message.client_phone,
        executive_name: result.message.executive_name,
        direction: result.message.direction,
        message: result.message.message,
        timestamp: result.message.timestamp,
      });
      return res.status(201).json({ success: true, data: result.message });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/dev/simulate-whatsapp', (req, res) => {
    try {
      const saved = simulateWhatsAppMessage(req.body || {});
      sendEvent('whatsapp.received', {
        id: saved.id,
        lead_id: saved.lead_id,
        client_name: saved.client_name,
        client_phone: saved.client_phone,
        executive_name: saved.executive_name,
        direction: saved.direction,
        message: saved.message,
        timestamp: saved.timestamp,
      });
      return res.status(201).json({ success: true, data: saved });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/whatsapp/sessions', (_req, res) => {
    return res.json({ success: true, data: getWhatsAppSessionsStatus() });
  });

  app.post('/api/whatsapp/sessions/:executiveId/start', async (req, res) => {
    try {
      const result = await startExecutiveWhatsAppSession(req.params.executiveId, { sendEvent });
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/whatsapp/sessions/:executiveId/disconnect', async (req, res) => {
    try {
      const result = await disconnectExecutiveWhatsAppSession(req.params.executiveId, { sendEvent });
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/executives', (_req, res) => {
    return res.json({ success: true, data: listExecutives() });
  });

  app.post('/api/executives', (req, res) => {
    try {
      const created = createExecutive(req.body || {});
      return res.status(201).json({ success: true, data: created });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.delete('/api/executives/:id', async (req, res) => {
    try {
      await disconnectExecutiveWhatsAppSession(req.params.id, { sendEvent }).catch(() => {});
      const removed = deleteExecutive(req.params.id);
      if (!removed) {
        return res.status(404).json({ success: false, message: 'Executive not found' });
      }
      return res.json({ success: true, data: { deleted: true, id: req.params.id } });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ============================================================
  // Pitch Training: Smart Playbook, AI Evaluation, Roleplay & Export
  // ============================================================

  app.get('/api/training/playbook', (req, res) => {
    const category = String(req.query.category || '').trim();
    return res.json({ success: true, data: listPlaybookRules({ category }) });
  });

  app.post('/api/training/playbook', (req, res) => {
    try {
      const rule = upsertPlaybookRule(req.body || {});
      return res.status(201).json({ success: true, data: rule });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.delete('/api/training/playbook/:id', (req, res) => {
    const deleted = deletePlaybookRule(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Playbook rule not found' });
    }
    return res.json({ success: true, data: { deleted: true, id: req.params.id } });
  });

  app.get('/api/training/coaching', (_req, res) => {
    const summary = getExecutiveCoachingSummary();
    return res.json({
      success: true,
      data: {
        ...summary,
        training_job: getTrainingJobStatus(),
        ai_configured: Boolean(process.env.GEMINI_API_KEY),
        ai_model: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
      },
    });
  });

  app.get('/api/training/backfill/status', (_req, res) => {
    return res.json({ success: true, data: getTrainingJobStatus() });
  });

  app.post('/api/training/backfill/start', async (req, res) => {
    try {
      const targetCount = Math.min(Math.max(Number(req.body?.targetCount || 100), 1), 500);
      const syncOlderCalls = req.body?.syncOlderCalls !== false;
      let syncSummary = null;
      if (syncOlderCalls && supabaseBridge?.backfillOlderCalls) {
        syncSummary = await supabaseBridge.backfillOlderCalls(Math.max(targetCount + 50, 150));
      }
      const status = startHistoricalCallBackfill({ targetCount });
      return res.status(202).json({
        success: true,
        data: {
          ...status,
          sync_summary: syncSummary,
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/training/backfill/stop', (_req, res) => {
    const status = stopHistoricalCallBackfill();
    return res.json({ success: true, data: status });
  });

  app.post('/api/training/auto-train', (req, res) => {
    const enabled = req.body?.enabled !== false;
    const status = setAutoTrainEnabled(enabled);
    return res.json({ success: true, data: status });
  });

  app.post('/api/training/evaluate/call/:callId', async (req, res) => {
    try {
      const evaluation = await evaluateCallPitch(req.params.callId);
      return res.status(201).json({ success: true, data: evaluation });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/training/evaluate/lead/:leadId', async (req, res) => {
    try {
      const evaluation = await evaluateLeadPitch(req.params.leadId);
      return res.status(201).json({ success: true, data: evaluation });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/training/evaluate/batch', async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.body?.limit || 4), 1), 10);
      const result = await evaluateRecentBatch({ limit });
      return res.json({ success: true, data: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/training/evaluations/:id/feedback', (req, res) => {
    try {
      const updated = updatePitchEvaluationFeedback(req.params.id, {
        managerStatus: req.body?.managerStatus || req.body?.manager_status || 'approved',
        managerScore: req.body?.managerScore ?? req.body?.manager_score ?? null,
        managerNote: req.body?.managerNote ?? req.body?.manager_note ?? '',
        managerTryLine: req.body?.managerTryLine ?? req.body?.manager_try_line ?? '',
      });
      if (!updated) {
        return res.status(404).json({ success: false, message: 'Evaluation not found' });
      }
      if (req.body?.addToPlaybook && (updated.manager_try_line || updated.try_line)) {
        upsertPlaybookRule({
          category: 'objection',
          title: `Winning Line (${updated.client_name || 'Client'})`,
          client_cue: updated.ai_summary || 'Real Climeto conversation',
          ideal_response: updated.manager_try_line || updated.try_line,
          priority: 1,
        });
      }
      return res.json({ success: true, data: updated });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.get('/api/training/export-jsonl', (_req, res) => {
    const jsonl = exportTrainingJsonl();
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', 'attachment; filename="climeto-pitch-finetune.jsonl"');
    return res.send(jsonl);
  });

  app.post('/api/training/suggest-reply/:leadId', async (req, res) => {
    try {
      const channel = String(req.body?.channel || 'whatsapp');
      const suggestion = await suggestBestReply(req.params.leadId, { channel });
      return res.json({ success: true, data: suggestion });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.get('/api/training/roleplay', (req, res) => {
    const executive = String(req.query.executive || '').trim();
    return res.json({
      success: true,
      data: {
        scenarios: ROLEPLAY_SCENARIOS,
        sessions: listRoleplaySessions({ executive }),
      },
    });
  });

  app.post('/api/training/roleplay/start', (req, res) => {
    try {
      const session = startRoleplay({
        executiveName: req.body?.executiveName || req.body?.executive_name || 'Sales Executive',
        scenarioId: req.body?.scenarioId || req.body?.scenario_id || 'price-negotiator',
      });
      return res.status(201).json({ success: true, data: session });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/training/roleplay/:id/message', async (req, res) => {
    try {
      const session = await replyToRoleplay(req.params.id, req.body?.message || '');
      return res.json({ success: true, data: session });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/training/roleplay/:id/finish', async (req, res) => {
    try {
      const session = await finishAndScoreRoleplay(req.params.id);
      return res.json({ success: true, data: session });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  // EPR Knowledge Base (PDF, Word .docx, ZIP, TXT uploads)
  app.get('/api/training/knowledge', (_req, res) => {
    return res.json({ success: true, data: listKnowledgeDocs() });
  });

  app.post('/api/training/knowledge/upload', knowledgeUpload.array('files', 10), async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ success: false, message: 'No files uploaded' });
      }
      const result = await ingestUploadedFiles(files);
      return res.status(201).json({ success: true, data: result });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.patch('/api/training/knowledge/:id', (req, res) => {
    const isActive = req.body?.is_active ?? req.body?.isActive ?? true;
    const updated = toggleKnowledgeDoc(req.params.id, Boolean(isActive));
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    return res.json({ success: true, data: updated });
  });

  app.delete('/api/training/knowledge/:id', (req, res) => {
    const deleted = deleteKnowledgeDoc(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    return res.json({ success: true, data: { deleted: true, id: req.params.id } });
  });

  app.post('/api/training/knowledge/generate-playbook', async (_req, res) => {
    try {
      const result = await generatePlaybookRulesFromKnowledge();
      return res.status(201).json({ success: true, data: result });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 360° Client Intel & Real Corporate Data Verification Routes
  // =========================================================================

  app.get('/api/training/intel', (req, res) => {
    const limit = Number(req.query.limit || 50);
    const search = String(req.query.search || '').trim();
    const temperature = String(req.query.temperature || '').trim();
    const list = listClientIntel({ limit, search, temperature });
    return res.json({ success: true, data: list });
  });

  app.get('/api/training/intel/target/:targetType/:targetId', (req, res) => {
    const intel = getClientIntelByTarget(req.params.targetType, req.params.targetId);
    if (!intel) {
      return res.status(404).json({ success: false, message: 'Intel not found for target' });
    }
    return res.json({ success: true, data: intel });
  });

  app.post('/api/training/intel/extract/:callId', async (req, res) => {
    try {
      const intel = await extractClientIntelForCall(req.params.callId);
      return res.status(201).json({ success: true, data: intel });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  // Candidate Search Disambiguation
  app.get('/api/training/intel/search-companies', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.status(400).json({ success: false, message: 'Search query q is required' });
    }
    try {
      const candidates = await searchByName(q);
      return res.json({ success: true, data: candidates });
    } catch (err) {
      const status = err.message.includes('not configured') ? 503 : 502;
      return res.status(status).json({ success: false, message: err.message });
    }
  });

  // Unified Dossier: Section A (Official MCA + Financials + Verified Scrape) + null Section B & C
  app.get('/api/training/intel/company/:cin/dossier', async (req, res) => {
    const cin = String(req.params.cin || '').trim();
    if (!cin) {
      return res.status(400).json({ success: false, message: 'CIN is required' });
    }

    try {
      // 1. Check cache (TTL 7 days)
      const cached = getCachedDossier(cin);
      if (cached?.section_a) {
        saveCompanySearch({
          query: req.query.q || cached.section_a.company_name?.value || cin,
          cin,
          name: cached.section_a.company_name?.value || cin,
        });
        return res.json({ success: true, data: createUnifiedDossier(cached.section_a), cached: true });
      }

      // 2. Fetch master data + financials in parallel
      const [masterData, financials] = await Promise.all([
        getMasterData(cin),
        getFinancials(cin).catch(() => ({ financial_year: null, turnover_inr: null })),
      ]);

      // 3. Official website scrape
      const websiteData = await scrapeOfficialWebsite({
        companyName: masterData.name,
        cin,
      }).catch(() => ({ website: null, email: null, phone: null, about_text: null, source_urls: [] }));

      // 4. Industry classification (Gemini)
      const industryData = await classifyIndustry({
        nicDescription: masterData.nic_description,
        aboutText: websiteData.about_text,
      }).catch(() => ({
        industry: masterData.nic_description || null,
        business_category: null,
        source: masterData.nic_description ? 'mca' : null,
        confidence: masterData.nic_description ? 1.0 : 0.0,
      }));

      // 5. Merge Section A
      const sectionA = mergeSectionA({
        mcaMaster: { ...masterData, cin },
        financials,
        websiteData,
        industryData,
      });

      // 6. Cache for 7 days & record search history
      setCachedDossier(cin, sectionA, 7);
      saveCompanySearch({
        query: req.query.q || masterData.name || cin,
        cin,
        name: masterData.name || cin,
      });

      return res.json({ success: true, data: createUnifiedDossier(sectionA), cached: false });
    } catch (err) {
      const status = err.message.includes('not configured') ? 503 : 502;
      return res.status(status).json({ success: false, message: err.message });
    }
  });

  // Recent Real Company Searches for Quick Lookup chips
  app.get('/api/training/intel/recent-searches', (_req, res) => {
    try {
      const recent = getRecentCompanySearches(5);
      return res.json({ success: true, data: recent });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/training/intel/lookup-company', async (req, res) => {
    const companyName = String(req.body?.company_name || req.body?.companyName || '').trim();
    const domain = String(req.body?.domain || '').trim();
    if (!companyName && !domain) {
      return res.status(400).json({ success: false, message: 'Company name or domain is required' });
    }
    try {
      const enriched = await enrichCompanyProfile({ companyName, domain });
      return res.json({ success: true, data: enriched });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.put('/api/training/intel/:id', (req, res) => {
    try {
      const existing = getClientIntelById(req.params.id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Intel record not found' });
      }
      const updated = upsertClientIntel({
        ...existing,
        ...req.body,
        target_type: existing.target_type,
        target_id: existing.target_id,
      });
      return res.json({ success: true, data: updated });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/training/intel/:id/sync-zoho', (req, res) => {
    try {
      const synced = syncClientIntelToZoho(req.params.id);
      return res.json({ success: true, data: synced });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  // ==========================================
  // CALL EXTRACTIONS & EVIDENCE VALIDATION (PROMPT 2)
  // ==========================================

  const getCallAnalysisHandler = async (req, res) => {
    const callId = String(req.params.id || '').trim();
    if (!callId) {
      return res.status(400).json({ success: false, message: 'callId is required' });
    }

    const call = getCallById(callId);
    let extractions = getCallExtractionsByCallId(callId);

    if (!call && extractions.length === 0) {
      return res.status(404).json({ success: false, message: 'Call not found' });
    }

    if (extractions.length === 0 && call?.transcript) {
      try {
        const validated = await extractCallIntelligence({
          transcript: call.transcript,
          callDate: call.created_at,
          callerNumber: call.client_phone,
        });
        extractions = saveBatchCallExtractions(callId, validated, 'gemini');
      } catch (err) {
        console.warn(`[CallExtractor] Auto-extraction error for call ${callId}:`, err.message);
      }
    }

    const sectionB = {};
    const sectionC = {};

    for (const row of extractions) {
      const isNeedsReview = Boolean(row.needs_review);
      const item = {
        value: row.value,
        evidence: row.evidence,
        timestamp: row.timestamp,
        confidence: row.confidence,
        needs_review: isNeedsReview,
        source: row.source,
        model: row.model,
      };

      if (row.field_name.startsWith('contact_person.')) {
        const key = row.field_name.replace('contact_person.', '');
        sectionB[key] = item;
      } else if (row.field_name.startsWith('sales_intelligence.')) {
        const key = row.field_name.replace('sales_intelligence.', '');
        sectionC[key] = item;
      }
    }

    return res.json({
      success: true,
      data: {
        call_id: callId,
        section_b: Object.keys(sectionB).length > 0 ? sectionB : null,
        section_c: Object.keys(sectionC).length > 0 ? sectionC : null,
        extractions,
      },
    });
  };

  const patchCallFieldHandler = (req, res) => {
    const callId = String(req.params.id || '').trim();
    const fieldName = String(req.params.fieldName || '').trim();
    const value = req.body?.value !== undefined ? req.body.value : null;

    if (!callId || !fieldName) {
      return res.status(400).json({ success: false, message: 'callId and fieldName are required' });
    }

    try {
      const updated = updateCallExtractionField({ callId, fieldName, value });
      return res.json({ success: true, data: updated });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  };

  app.get('/api/calls/:id/analysis', getCallAnalysisHandler);
  app.get('/api/training/intel/calls/:id/analysis', getCallAnalysisHandler);

  app.patch('/api/calls/:id/fields/:fieldName', patchCallFieldHandler);
  app.patch('/api/training/intel/calls/:id/fields/:fieldName', patchCallFieldHandler);

  return app;
}
