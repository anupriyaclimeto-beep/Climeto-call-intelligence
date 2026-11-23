import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4200';

const CATEGORY_LABELS = {
  discovery: 'Discovery Question',
  objection: 'Objection Rebuttal',
  whatsapp_template: 'WhatsApp Template',
  red_flag: 'Red Flag (Avoid)',
  opener: 'Call Opener',
};

const PILLAR_LABELS = [
  { key: 'opener', label: 'Opener' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'value_pitch', label: 'Value Pitch' },
  { key: 'objection_handling', label: 'Objections' },
  { key: 'closing', label: 'Closing' },
  { key: 'followup', label: 'Follow-up' },
];

function scoreTheme(score) {
  const n = Number(score || 0);
  if (n >= 7.5) return { bg: '#dcfce7', text: '#166534', bar: '#16a34a', label: 'Strong' };
  if (n >= 5) return { bg: '#fef3c7', text: '#92400e', bar: '#d97706', label: 'Needs Polish' };
  return { bg: '#fee2e2', text: '#991b1b', bar: '#dc2626', label: 'Coach Priority' };
}

const panelStyle = {
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: '16px',
  padding: '1.25rem 1.4rem',
  boxShadow: '0 2px 6px rgba(15, 23, 42, 0.04)',
};

const subCardStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.8rem',
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: '14px',
  padding: '1.1rem 1.25rem',
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
};

export default function PitchTrainingPage() {
  const [activeTab, setActiveTab] = useState('coaching'); // coaching | playbook | roleplay | knowledge
  const [coaching, setCoaching] = useState(null);
  const [playbook, setPlaybook] = useState([]);
  const [roleplayData, setRoleplayData] = useState({ scenarios: [], sessions: [] });
  const [knowledgeDocs, setKnowledgeDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [banner, setBanner] = useState('');
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState('');

  // Coaching filters & expand state
  const [execFilter, setExecFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedEvalId, setExpandedEvalId] = useState(null);

  // Manager feedback edit state
  const [editingEvalId, setEditingEvalId] = useState(null);
  const [editScore, setEditScore] = useState('');
  const [editTryLine, setEditTryLine] = useState('');
  const [editNote, setEditNote] = useState('');
  const [promoteToPlaybook, setPromoteToPlaybook] = useState(true);

  // Playbook state
  const [pbFilter, setPbFilter] = useState('');
  const [showAddRule, setShowAddRule] = useState(false);
  const [pbCategory, setPbCategory] = useState('objection');
  const [pbTitle, setPbTitle] = useState('');
  const [pbCue, setPbCue] = useState('');
  const [pbResponse, setPbResponse] = useState('');
  const [savingRule, setSavingRule] = useState(false);

  // Roleplay state
  const [rpExecName, setRpExecName] = useState('');
  const [rpScenarioId, setRpScenarioId] = useState('price-negotiator');
  const [activeRoleplay, setActiveRoleplay] = useState(null);
  const [rpInput, setRpInput] = useState('');
  const [rpBusy, setRpBusy] = useState(false);

  // EPR Knowledge Base state
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [generatingRules, setGeneratingRules] = useState(false);

  // Dual-lane Call Pitch Training state (100+ older calls + live new calls)
  const [trainingJob, setTrainingJob] = useState(null);
  const [backfillBusy, setBackfillBusy] = useState(false);

  const loadAll = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      const [coachRes, pbRes, rpRes, kbRes] = await Promise.all([
        fetch(`${API_BASE}/api/training/coaching`),
        fetch(`${API_BASE}/api/training/playbook`),
        fetch(`${API_BASE}/api/training/roleplay`),
        fetch(`${API_BASE}/api/training/knowledge`),
      ]);
      const [coachJson, pbJson, rpJson, kbJson] = await Promise.all([
        coachRes.json(),
        pbRes.json(),
        rpRes.json(),
        kbRes.json(),
      ]);
      if (coachJson.success) {
        setCoaching(coachJson.data);
        if (coachJson.data?.training_job) {
          setTrainingJob(coachJson.data.training_job);
        }
      }
      if (pbJson.success) setPlaybook(pbJson.data || []);
      if (rpJson.success) setRoleplayData(rpJson.data || { scenarios: [], sessions: [] });
      if (kbJson.success) setKnowledgeDocs(kbJson.data || []);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load Pitch Training data');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Live SSE updates for dual-lane pitch training (older backfill + incoming new calls)
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/events`);
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data || '{}');
        if (parsed.type === 'training.progress' && parsed.payload) {
          setTrainingJob(parsed.payload);
        } else if (parsed.type === 'pitch.evaluated') {
          loadAll({ silent: true });
        }
      } catch {
        // Ignore malformed SSE packets
      }
    };
    return () => es.close();
  }, [loadAll]);

  async function handleStartBackfill() {
    try {
      setBackfillBusy(true);
      setBanner('Syncing older calls from Calling DB and starting background pitch training (100 calls)...');
      const res = await fetch(`${API_BASE}/api/training/backfill/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetCount: 100, syncOlderCalls: true }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to start backfill');
      setTrainingJob(json.data);
      const target = json.data?.target_count || 0;
      setBanner(
        target > 0
          ? `Started background pitch training for ${target} older call(s). New incoming calls will continue to auto-train side-by-side.`
          : 'All synced calls are already evaluated.',
      );
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Backfill error: ${err.message}`);
    } finally {
      setBackfillBusy(false);
    }
  }

  async function handleStopBackfill() {
    try {
      setBackfillBusy(true);
      const res = await fetch(`${API_BASE}/api/training/backfill/stop`, { method: 'POST' });
      const json = await res.json();
      if (json.success) setTrainingJob(json.data);
      setBanner('Paused older calls backfill. Live auto-training on new calls remains active.');
    } catch (err) {
      setBanner(`Error: ${err.message}`);
    } finally {
      setBackfillBusy(false);
    }
  }

  async function handleToggleAutoTrain() {
    const nextState = !(trainingJob?.auto_train_enabled ?? true);
    try {
      const res = await fetch(`${API_BASE}/api/training/auto-train`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextState }),
      });
      const json = await res.json();
      if (json.success) setTrainingJob(json.data);
      setBanner(
        nextState
          ? 'Live auto-training enabled: every new completed call will be evaluated automatically.'
          : 'Live auto-training paused for incoming calls.',
      );
    } catch (err) {
      setBanner(`Error: ${err.message}`);
    }
  }

  function handleCopy(text, id) {
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(''), 1800);
  }

  async function handleRunBatchAnalysis() {
    try {
      setAnalyzing(true);
      setBanner('Gemini AI is evaluating your latest Calls & WhatsApp conversations...');
      const res = await fetch(`${API_BASE}/api/training/evaluate/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 4 }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Analysis failed');
      const count = json.data?.evaluated_count || 0;
      setBanner(
        count > 0
          ? `✅ Analyzed ${count} new call/WhatsApp interaction(s) with Gemini AI!`
          : 'All recent calls and WhatsApp leads are already evaluated.',
      );
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Analysis error: ${err.message}`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleQuickApprove(ev) {
    try {
      const res = await fetch(`${API_BASE}/api/training/evaluations/${ev.id}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          managerStatus: 'approved',
          managerScore: ev.overall_score,
          managerNote: 'Approved by manager for AI calibration',
          managerTryLine: ev.try_line,
        }),
      });
      if (!res.ok) throw new Error('Failed to approve');
      setBanner(`✅ Approved evaluation for ${ev.client_name}.`);
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Error: ${err.message}`);
    }
  }

  async function handleSaveEditedFeedback(e) {
    e.preventDefault();
    if (!editingEvalId) return;
    try {
      const res = await fetch(`${API_BASE}/api/training/evaluations/${editingEvalId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          managerStatus: 'edited',
          managerScore: editScore !== '' ? Number(editScore) : null,
          managerNote: editNote,
          managerTryLine: editTryLine,
          addToPlaybook: promoteToPlaybook,
        }),
      });
      if (!res.ok) throw new Error('Failed to save feedback');
      setEditingEvalId(null);
      setBanner(
        promoteToPlaybook
          ? '✅ Feedback saved & winning line added to Smart Playbook!'
          : '✅ Manager feedback saved!',
      );
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Error: ${err.message}`);
    }
  }

  async function handleAddPlaybookRule(e) {
    e.preventDefault();
    if (!pbTitle.trim() || !pbResponse.trim()) return;
    try {
      setSavingRule(true);
      const res = await fetch(`${API_BASE}/api/training/playbook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: pbCategory,
          title: pbTitle.trim(),
          client_cue: pbCue.trim(),
          ideal_response: pbResponse.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to save rule');
      setPbTitle('');
      setPbCue('');
      setPbResponse('');
      setShowAddRule(false);
      setBanner(`✅ Added "${json.data.title}" to Smart Playbook.`);
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Error: ${err.message}`);
    } finally {
      setSavingRule(false);
    }
  }

  async function handleDeleteRule(id) {
    try {
      await fetch(`${API_BASE}/api/training/playbook/${id}`, { method: 'DELETE' });
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Error: ${err.message}`);
    }
  }

  async function handleStartRoleplay(scenarioIdOverride) {
    const targetScenario = scenarioIdOverride || rpScenarioId;
    setRpScenarioId(targetScenario);
    try {
      setRpBusy(true);
      const res = await fetch(`${API_BASE}/api/training/roleplay/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          executiveName: rpExecName.trim() || 'Sales Executive',
          scenarioId: targetScenario,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setActiveRoleplay(json.data);
        setRpInput('');
      }
    } catch (err) {
      setBanner(`Roleplay start error: ${err.message}`);
    } finally {
      setRpBusy(false);
    }
  }

  async function handleSendRoleplayMessage(e) {
    e.preventDefault();
    if (!activeRoleplay || !rpInput.trim() || rpBusy) return;
    try {
      setRpBusy(true);
      const msg = rpInput.trim();
      setRpInput('');
      const res = await fetch(`${API_BASE}/api/training/roleplay/${activeRoleplay.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const json = await res.json();
      if (json.success) setActiveRoleplay(json.data);
    } catch (err) {
      setBanner(`Roleplay reply error: ${err.message}`);
    } finally {
      setRpBusy(false);
    }
  }

  async function handleFinishRoleplay() {
    if (!activeRoleplay || rpBusy) return;
    try {
      setRpBusy(true);
      const res = await fetch(`${API_BASE}/api/training/roleplay/${activeRoleplay.id}/finish`, {
        method: 'POST',
      });
      const json = await res.json();
      if (json.success) {
        setActiveRoleplay(json.data);
        await loadAll({ silent: true });
      }
    } catch (err) {
      setBanner(`Scoring error: ${err.message}`);
    } finally {
      setRpBusy(false);
    }
  }

  async function handleUploadKnowledgeFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    try {
      setUploadingDocs(true);
      setBanner(`Uploading & extracting text from ${files.length} file(s)...`);
      const formData = new FormData();
      for (const f of files) {
        formData.append('files', f);
      }
      const res = await fetch(`${API_BASE}/api/training/knowledge/upload`, {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Upload failed');
      const okCount = json.data?.ingested?.length || 0;
      const skipCount = json.data?.skipped?.length || 0;
      const skipNote = skipCount > 0 ? ` (${skipCount} skipped: ${json.data.skipped[0]?.reason || 'unsupported'})` : '';
      setBanner(`✅ Uploaded & indexed ${okCount} EPR document(s)!${skipNote}`);
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Upload error: ${err.message}`);
    } finally {
      setUploadingDocs(false);
    }
  }

  async function handleToggleDoc(doc) {
    try {
      await fetch(`${API_BASE}/api/training/knowledge/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !doc.is_active }),
      });
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Error: ${err.message}`);
    }
  }

  async function handleDeleteDoc(id) {
    try {
      await fetch(`${API_BASE}/api/training/knowledge/${id}`, { method: 'DELETE' });
      setBanner('Document removed from Knowledge Base.');
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Error: ${err.message}`);
    }
  }

  async function handleGeneratePlaybookFromDocs() {
    try {
      setGeneratingRules(true);
      setBanner('Gemini AI is reading your EPR documents to generate Smart Playbook rules...');
      const res = await fetch(`${API_BASE}/api/training/knowledge/generate-playbook`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to generate rules');
      setBanner(`✨ Added ${json.data?.created_count || 0} new EPR rules to Smart Playbook!`);
      await loadAll({ silent: true });
    } catch (err) {
      setBanner(`Error: ${err.message}`);
    } finally {
      setGeneratingRules(false);
    }
  }

  const stats = coaching?.stats || {};
  const callCoverage = trainingJob?.call_coverage || coaching?.call_coverage || {
    total_calls_synced: 0,
    calls_evaluated: 0,
    calls_pending: 0,
  };
  const coveragePct = callCoverage.total_calls_synced > 0
    ? Math.min(100, Math.round((callCoverage.calls_evaluated / callCoverage.total_calls_synced) * 100))
    : 0;
  const isBackfillRunning = Boolean(trainingJob?.running);
  const isAutoTrainOn = trainingJob?.auto_train_enabled ?? true;
  const allExecs = coaching?.executives || [];
  const filteredExecs = execFilter ? allExecs.filter((e) => e.executive_name === execFilter) : allExecs;

  const filteredEvaluations = useMemo(() => {
    return (coaching?.evaluations || []).filter((ev) => {
      if (execFilter && ev.executive_name !== execFilter) return false;
      if (channelFilter && ev.target_type !== channelFilter) return false;
      if (statusFilter === 'pending' && ev.manager_status !== 'pending') return false;
      if (statusFilter === 'approved' && ev.manager_status === 'pending') return false;
      return true;
    });
  }, [coaching, execFilter, channelFilter, statusFilter]);

  const filteredPlaybook = pbFilter ? playbook.filter((r) => r.category === pbFilter) : playbook;

  return (
    <section className="page-stack" style={{ gap: '1.15rem' }}>
      {/* TOP HEADER & 3-STEP QUICK WORKFLOW */}
      <section style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: '0.25rem' }}>AI Software + Executive Training</div>
            <h3 style={{ margin: '0 0 0.3rem 0', fontSize: '1.35rem', color: '#0f172a' }}>Climeto Pitch Training Hub</h3>
            <p style={{ margin: 0, color: '#475569', fontSize: '0.9rem' }}>
              Score real Calls &amp; WhatsApp chats with Gemini AI, coach executives with exact Hinglish lines, and train your AI brain.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={`pill ${coaching?.ai_configured ? 'good' : 'neutral'}`}>
              {coaching?.ai_configured ? `🟢 Gemini Live` : '⚪ Offline Mode'}
            </span>
            <button
              type="button"
              className="primary-button"
              disabled={analyzing}
              onClick={handleRunBatchAnalysis}
              style={{ padding: '0.5rem 1rem', fontSize: '0.84rem', fontWeight: 600 }}
            >
              {analyzing ? '⏳ Analyzing...' : '✨ Analyze Calls & WhatsApp'}
            </button>
            <a
              className="ghost-button"
              href={`${API_BASE}/api/training/export-jsonl`}
              download="climeto-pitch-finetune.jsonl"
              style={{ padding: '0.5rem 0.85rem', fontSize: '0.82rem', textDecoration: 'none' }}
            >
              ⬇️ Export JSONL
            </a>
          </div>
        </div>

        {/* DUAL-LANE CALL TRAINING PIPELINE BAR (100+ OLDER CALLS + LIVE NEW CALLS) */}
        <div
          style={{
            marginTop: '1rem',
            padding: '0.85rem 1rem',
            borderRadius: '12px',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.85rem',
          }}
        >
          <div style={{ flex: '1 1 280px', minWidth: '240px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
              <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#0f172a' }}>
                📞 Call Training Coverage: {callCoverage.calls_evaluated} / {callCoverage.total_calls_synced} synced calls ({coveragePct}%)
              </span>
              {isBackfillRunning && (
                <span style={{ fontSize: '0.76rem', fontWeight: 600, color: '#2563eb' }}>
                  ⏳ Training {trainingJob.processed}/{trainingJob.target_count}
                  {trainingJob.current_call ? ` · ${trainingJob.current_call.client_name}` : ''}
                </span>
              )}
            </div>
            <div style={{ height: '7px', background: '#e2e8f0', borderRadius: '999px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${coveragePct}%`,
                  height: '100%',
                  background: isBackfillRunning ? '#2563eb' : '#16a34a',
                  borderRadius: '999px',
                  transition: 'width 0.35s ease',
                }}
              />
            </div>
            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.3rem' }}>
              {callCoverage.calls_pending > 0
                ? `${callCoverage.calls_pending} older call(s) pending evaluation · New incoming calls are prioritized automatically.`
                : 'All synced calls are evaluated. New incoming calls will be evaluated automatically.'}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {isBackfillRunning ? (
              <button
                type="button"
                className="ghost-button"
                disabled={backfillBusy}
                onClick={handleStopBackfill}
                style={{ padding: '0.45rem 0.9rem', fontSize: '0.82rem', fontWeight: 600, borderColor: '#f59e0b', color: '#b45309' }}
              >
                ⏸ Pause Backfill
              </button>
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={backfillBusy}
                onClick={handleStartBackfill}
                style={{ padding: '0.45rem 0.95rem', fontSize: '0.82rem', fontWeight: 600 }}
              >
                {backfillBusy ? '⏳ Syncing...' : '🚀 Train 100 Older Calls'}
              </button>
            )}

            <button
              type="button"
              onClick={handleToggleAutoTrain}
              title="Toggle automatic pitch training when new calls complete"
              style={{
                padding: '0.45rem 0.85rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                borderRadius: '10px',
                cursor: 'pointer',
                border: isAutoTrainOn ? '1px solid #86efac' : '1px solid #cbd5e1',
                background: isAutoTrainOn ? '#dcfce7' : '#ffffff',
                color: isAutoTrainOn ? '#166534' : '#475569',
              }}
            >
              {isAutoTrainOn ? '🟢 Live New Calls: Auto-Train ON' : '⚪ Live New Calls: Auto-Train OFF'}
            </button>
          </div>
        </div>

        {/* 3-STEP GUIDED WORKFLOW STRIP */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '0.75rem',
            marginTop: '1.1rem',
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('knowledge')}
            style={{
              textAlign: 'left',
              padding: '0.75rem 0.95rem',
              borderRadius: '12px',
              border: activeTab === 'knowledge' ? '2px solid #2563eb' : '1px solid #e2e8f0',
              background: activeTab === 'knowledge' ? '#eff6ff' : '#f8fafc',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' }}>Step 1 · Feed Knowledge</div>
            <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '0.92rem', marginTop: '0.15rem' }}>
              📚 EPR Docs ({knowledgeDocs.length})
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.15rem' }}>
              Upload PDF, Word, ZIP or RAR guides
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('coaching')}
            style={{
              textAlign: 'left',
              padding: '0.75rem 0.95rem',
              borderRadius: '12px',
              border: activeTab === 'coaching' ? '2px solid #2563eb' : '1px solid #e2e8f0',
              background: activeTab === 'coaching' ? '#eff6ff' : '#f8fafc',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' }}>Step 2 · Score &amp; Review</div>
            <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '0.92rem', marginTop: '0.15rem' }}>
              📊 Scorecards ({stats.total_evaluated ?? 0}) · Avg {stats.avg_score ?? 0}/10
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.15rem' }}>
              {stats.manager_approved ?? 0} approved for AI calibration
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('playbook')}
            style={{
              textAlign: 'left',
              padding: '0.75rem 0.95rem',
              borderRadius: '12px',
              border: activeTab === 'playbook' ? '2px solid #2563eb' : '1px solid #e2e8f0',
              background: activeTab === 'playbook' ? '#eff6ff' : '#f8fafc',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' }}>Step 3 · Refine Rules</div>
            <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '0.92rem', marginTop: '0.15rem' }}>
              📘 Smart Playbook ({playbook.length})
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.15rem' }}>
              Winning discovery &amp; objection scripts
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('roleplay')}
            style={{
              textAlign: 'left',
              padding: '0.75rem 0.95rem',
              borderRadius: '12px',
              border: activeTab === 'roleplay' ? '2px solid #2563eb' : '1px solid #e2e8f0',
              background: activeTab === 'roleplay' ? '#eff6ff' : '#f8fafc',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' }}>Step 4 · Practice Live</div>
            <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '0.92rem', marginTop: '0.15rem' }}>
              🎯 AI Roleplay Drills
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.15rem' }}>
              Practice tough EPR objections live
            </div>
          </button>
        </div>

        {banner ? (
          <div style={{ marginTop: '0.9rem', padding: '0.65rem 0.95rem', borderRadius: '10px', background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0', fontSize: '0.86rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{banner}</span>
            <button type="button" onClick={() => setBanner('')} style={{ background: 'none', border: 'none', color: '#065f46', cursor: 'pointer', fontWeight: 700 }}>✕</button>
          </div>
        ) : null}
        {error ? <div className="status-card error" style={{ marginTop: '0.75rem' }}>{error}</div> : null}
      </section>

      {loading ? <div className="status-card">Loading Pitch Training workspace...</div> : null}

      {/* ============================================================
          TAB 1: COACHING & SCORECARDS
      ============================================================ */}
      {!loading && activeTab === 'coaching' ? (
        <>
          {/* COMPACT EXECUTIVE FILTER DROPDOWN */}
          {allExecs.length > 0 ? (
            <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap', alignItems: 'center', background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '0.65rem 1rem' }}>
              <label htmlFor="exec-filter-select" style={{ fontSize: '0.82rem', fontWeight: 600, color: '#475569' }}>
                👤 Executive:
              </label>
              <select
                id="exec-filter-select"
                value={execFilter}
                onChange={(e) => setExecFilter(e.target.value)}
                style={{
                  minWidth: '240px',
                  padding: '0.42rem 0.75rem',
                  borderRadius: '8px',
                  border: '1px solid #cbd5e1',
                  background: '#f8fafc',
                  color: '#0f172a',
                  fontSize: '0.84rem',
                  fontWeight: 500,
                }}
              >
                <option value="">All Executives ({allExecs.length})</option>
                {allExecs.map((ex) => (
                  <option key={ex.executive_name} value={ex.executive_name}>
                    {ex.executive_name} — Avg {ex.avg_score}/10 ({ex.evaluated_count} evals)
                  </option>
                ))}
              </select>
              {execFilter ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setExecFilter('')}
                  style={{ padding: '0.35rem 0.7rem', fontSize: '0.78rem' }}
                >
                  ✕ Clear
                </button>
              ) : null}
            </div>
          ) : null}

          {/* EXECUTIVE SKILL SCORECARDS */}
          <section style={panelStyle}>
            <div style={{ marginBottom: '0.9rem' }}>
              <h3 style={{ margin: '0 0 0.2rem 0', fontSize: '1.1rem', color: '#0f172a' }}>Executive Skill Scorecards</h3>
              <p style={{ margin: 0, fontSize: '0.84rem', color: '#64748b' }}>
                6-pillar breakdown across Calls &amp; WhatsApp conversations.
              </p>
            </div>

            {filteredExecs.length ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1rem' }}>
                {filteredExecs.map((ex) => {
                  const sc = scoreTheme(ex.avg_score);
                  return (
                    <div key={ex.executive_name} style={subCardStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                          <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: '#0f172a', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.88rem' }}>
                            {ex.executive_name.replace(/^\+/, '').slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: '0.98rem', color: '#0f172a' }}>{ex.executive_name}</div>
                            <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
                              {ex.evaluated_count} evaluated · {ex.approved_count} approved
                              {ex.phone && ex.phone !== ex.executive_name ? ` · ${ex.phone}` : ''}
                              {ex.email ? ` · ${ex.email}` : ''}
                            </div>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <span style={{ background: sc.bg, color: sc.text, fontWeight: 700, fontSize: '0.84rem', padding: '0.3rem 0.7rem', borderRadius: '999px', display: 'inline-block' }}>
                            {ex.avg_score} / 10
                          </span>
                          <div style={{ fontSize: '0.72rem', color: sc.text, marginTop: '0.15rem', fontWeight: 600 }}>{sc.label}</div>
                        </div>
                      </div>

                      {/* 6-Channel Unified Activity Strip */}
                      {ex.channels ? (
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', fontSize: '0.73rem' }}>
                          <span style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', background: '#f1f5f9', color: '#334155', fontWeight: 600 }}>
                            📞 {ex.channels.calls ?? 0} Calls
                          </span>
                          <span style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', background: '#ecfdf5', color: '#065f46', fontWeight: 600 }}>
                            💬 {ex.channels.whatsapp ?? 0} WhatsApp
                          </span>
                          <span style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', background: '#eff6ff', color: '#1e40af', fontWeight: 600 }}>
                            📧 {ex.channels.zoho_emails ?? 0} Zoho Mails
                          </span>
                          <span style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>
                            📣 {ex.channels.campaigns ?? 0} Campaigns
                          </span>
                          <span style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', background: '#f3e8ff', color: '#6b21a8', fontWeight: 600 }}>
                            💼 {ex.channels.leads ?? 0} Leads · {ex.channels.zoho_accounts ?? 0} CRM Accts
                          </span>
                        </div>
                      ) : null}

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.65rem', background: '#f8fafc', padding: '0.75rem', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                        {PILLAR_LABELS.map((p) => {
                          const val = Number(ex.pillars?.[p.key] ?? 0);
                          const c = scoreTheme(val);
                          return (
                            <div key={p.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.76rem' }}>
                                <span style={{ color: '#475569' }}>{p.label}</span>
                                <strong style={{ color: '#0f172a' }}>{val}</strong>
                              </div>
                              <div style={{ height: '6px', background: '#e2e8f0', borderRadius: '999px', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(Math.max(val * 10, 0), 100)}%`, height: '100%', background: c.bar }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {ex.top_gaps?.length ? (
                        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '10px', padding: '0.6rem 0.8rem', fontSize: '0.81rem', color: '#78350f' }}>
                          <strong>🎯 Top Focus:</strong> {ex.top_gaps[0]}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="status-card muted">
                No evaluations yet. Click <strong>"✨ Analyze Calls &amp; WhatsApp"</strong> at the top to generate live Gemini scorecards!
              </div>
            )}
          </section>

          {/* EVALUATED CALLS & CHATS */}
          <section style={panelStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.9rem' }}>
              <div>
                <h3 style={{ margin: '0 0 0.2rem 0', fontSize: '1.1rem', color: '#0f172a' }}>
                  Evaluated Calls &amp; Chats ({filteredEvaluations.length})
                </h3>
                <p style={{ margin: 0, fontSize: '0.84rem', color: '#64748b' }}>
                  Click any card to see detailed Strengths, Gaps &amp; Red Flags, or approve directly to train AI.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {['', 'call', 'lead'].map((ch) => (
                  <button
                    key={ch || 'all-ch'}
                    type="button"
                    className={channelFilter === ch ? 'primary-button' : 'ghost-button'}
                    onClick={() => setChannelFilter(ch)}
                    style={{ padding: '0.28rem 0.65rem', fontSize: '0.76rem' }}
                  >
                    {ch === 'call' ? '📞 Calls' : ch === 'lead' ? '💬 WhatsApp Leads' : 'All Channels'}
                  </button>
                ))}
                {['', 'pending', 'approved'].map((st) => (
                  <button
                    key={st || 'all-st'}
                    type="button"
                    className={statusFilter === st ? 'primary-button' : 'ghost-button'}
                    onClick={() => setStatusFilter(st)}
                    style={{ padding: '0.28rem 0.65rem', fontSize: '0.76rem' }}
                  >
                    {st === 'pending' ? '⏳ Pending' : st === 'approved' ? '✅ Approved' : 'All Status'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {filteredEvaluations.map((ev) => {
                const effScore = ev.manager_score ?? ev.overall_score;
                const sc = scoreTheme(effScore);
                const isExpanded = expandedEvalId === ev.id || editingEvalId === ev.id;
                const displayTryLine = ev.manager_try_line || ev.try_line;

                return (
                  <div
                    key={ev.id}
                    style={{
                      ...subCardStyle,
                      borderLeft: ev.manager_status !== 'pending' ? '5px solid #16a34a' : `5px solid ${sc.bar}`,
                    }}
                  >
                    {/* Compact Summary Header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.6rem' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '0.18rem 0.5rem', borderRadius: '6px', background: ev.target_type === 'call' ? '#e0e7ff' : '#dcfce7', color: ev.target_type === 'call' ? '#3730a3' : '#166534' }}>
                            {ev.target_type === 'call' ? '📞 CALL' : '💬 WHATSAPP'}
                          </span>
                          <strong style={{ fontSize: '0.98rem', color: '#0f172a' }}>{ev.client_name}</strong>
                          <span style={{ fontSize: '0.82rem', color: '#64748b' }}>· {ev.executive_name}</span>
                        </div>
                        <p style={{ margin: '0.35rem 0 0 0', fontSize: '0.87rem', color: '#334155', lineHeight: 1.45 }}>
                          {ev.ai_summary}
                        </p>
                      </div>

                      <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexShrink: 0 }}>
                        <span style={{ background: sc.bg, color: sc.text, fontWeight: 700, fontSize: '0.82rem', padding: '0.28rem 0.7rem', borderRadius: '999px' }}>
                          {effScore} / 10
                        </span>
                        <span className={`pill ${ev.manager_status !== 'pending' ? 'good' : 'neutral'}`} style={{ fontSize: '0.75rem' }}>
                          {ev.manager_status === 'approved' ? '✅ Approved' : ev.manager_status === 'edited' ? '✏️ Calibrated' : '⏳ Pending'}
                        </span>
                      </div>
                    </div>

                    {/* Highlighted Try Line with 1-Click Copy */}
                    {displayTryLine ? (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '0.65rem 0.9rem', borderRadius: '10px', fontSize: '0.85rem', color: '#1e3a8a' }}>
                        <div>
                          <strong>💬 Better Line to Say:</strong> "{displayTryLine}"
                        </div>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => handleCopy(displayTryLine, ev.id)}
                          style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem', flexShrink: 0 }}
                        >
                          {copiedId === ev.id ? '✅ Copied' : '📋 Copy'}
                        </button>
                      </div>
                    ) : null}

                    {/* Expandable Full Breakdown */}
                    {isExpanded ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0.7rem', fontSize: '0.83rem' }}>
                        {ev.strengths?.length ? (
                          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '0.65rem 0.85rem', borderRadius: '10px', color: '#14532d' }}>
                            <strong>✅ What Went Well</strong>
                            <ul style={{ margin: '0.3rem 0 0 1.05rem', padding: 0, display: 'grid', gap: '0.2rem' }}>
                              {ev.strengths.map((s, idx) => <li key={idx}>{s}</li>)}
                            </ul>
                          </div>
                        ) : null}
                        {ev.gaps?.length ? (
                          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: '0.65rem 0.85rem', borderRadius: '10px', color: '#78350f' }}>
                            <strong>⚠️ What Was Missed</strong>
                            <ul style={{ margin: '0.3rem 0 0 1.05rem', padding: 0, display: 'grid', gap: '0.2rem' }}>
                              {ev.gaps.map((g, idx) => <li key={idx}>{g}</li>)}
                            </ul>
                          </div>
                        ) : null}
                        {ev.red_flags?.length ? (
                          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', padding: '0.65rem 0.85rem', borderRadius: '10px', color: '#7f1d1d' }}>
                            <strong>🚩 Red Flags</strong>
                            <ul style={{ margin: '0.3rem 0 0 1.05rem', padding: 0, display: 'grid', gap: '0.2rem' }}>
                              {ev.red_flags.map((rf, idx) => <li key={idx}>{rf}</li>)}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {/* Edit Form or Clean Action Row */}
                    {editingEvalId === ev.id ? (
                      <form onSubmit={handleSaveEditedFeedback} style={{ display: 'grid', gap: '0.55rem', padding: '0.85rem', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '10px' }}>
                        <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            max="10"
                            placeholder="Manager Score (0-10)"
                            value={editScore}
                            onChange={(e) => setEditScore(e.target.value)}
                            style={{ width: '165px', padding: '0.45rem 0.65rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                          />
                          <input
                            type="text"
                            placeholder="Manager coaching note..."
                            value={editNote}
                            onChange={(e) => setEditNote(e.target.value)}
                            style={{ flex: 1, minWidth: '200px', padding: '0.45rem 0.65rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                          />
                        </div>
                        <textarea
                          rows={2}
                          placeholder="Better Hinglish / English Try Line..."
                          value={editTryLine}
                          onChange={(e) => setEditTryLine(e.target.value)}
                          style={{ padding: '0.5rem 0.65rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                        />
                        <label style={{ fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.45rem', color: '#334155' }}>
                          <input type="checkbox" checked={promoteToPlaybook} onChange={(e) => setPromoteToPlaybook(e.target.checked)} />
                          Also add this winning line to Climeto Smart Playbook
                        </label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button type="submit" className="primary-button" style={{ padding: '0.38rem 0.85rem', fontSize: '0.8rem' }}>Save</button>
                          <button type="button" className="ghost-button" onClick={() => setEditingEvalId(null)} style={{ padding: '0.38rem 0.85rem', fontSize: '0.8rem' }}>Cancel</button>
                        </div>
                      </form>
                    ) : (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => handleQuickApprove(ev)}
                            style={{ padding: '0.32rem 0.75rem', fontSize: '0.78rem' }}
                          >
                            👍 Approve
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => {
                              setEditingEvalId(ev.id);
                              setEditScore(String(ev.manager_score ?? ev.overall_score ?? ''));
                              setEditTryLine(ev.manager_try_line || ev.try_line || '');
                              setEditNote(ev.manager_note || '');
                            }}
                            style={{ padding: '0.32rem 0.75rem', fontSize: '0.78rem' }}
                          >
                            ✏️ Edit &amp; Teach AI
                          </button>
                        </div>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => setExpandedEvalId(isExpanded ? null : ev.id)}
                          style={{ padding: '0.3rem 0.7rem', fontSize: '0.78rem', color: '#2563eb' }}
                        >
                          {isExpanded ? '▲ Hide Breakdown' : '▼ View Full Breakdown'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredEvaluations.length === 0 ? (
                <div className="status-card muted">No evaluations match the selected filter.</div>
              ) : null}
            </div>
          </section>
        </>
      ) : null}

      {/* ============================================================
          TAB 2: SMART PLAYBOOK
      ============================================================ */}
      {!loading && activeTab === 'playbook' ? (
        <section style={panelStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
            <div>
              <h3 style={{ margin: '0 0 0.2rem 0', fontSize: '1.1rem', color: '#0f172a' }}>Climeto Smart Living Playbook</h3>
              <p style={{ margin: 0, fontSize: '0.84rem', color: '#64748b' }}>
                Ready-to-copy Hinglish/English scripts &amp; rules used by Gemini AI to score your team.
              </p>
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={() => setShowAddRule((v) => !v)}
              style={{ padding: '0.45rem 0.9rem', fontSize: '0.82rem' }}
            >
              {showAddRule ? '✕ Close Form' : '+ Add New Rule'}
            </button>
          </div>

          {showAddRule ? (
            <form
              onSubmit={handleAddPlaybookRule}
              style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '12px', padding: '1rem', marginBottom: '1rem', display: 'grid', gap: '0.6rem' }}
            >
              <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
                <select value={pbCategory} onChange={(e) => setPbCategory(e.target.value)} style={{ padding: '0.48rem 0.65rem', borderRadius: '8px', border: '1px solid #cbd5e1', background: '#fff' }}>
                  <option value="discovery">Discovery Question</option>
                  <option value="objection">Objection Rebuttal</option>
                  <option value="whatsapp_template">WhatsApp Template</option>
                  <option value="opener">Call Opener</option>
                  <option value="red_flag">Red Flag (Avoid)</option>
                </select>
                <input type="text" placeholder="Rule Title" value={pbTitle} onChange={(e) => setPbTitle(e.target.value)} required style={{ flex: '1 1 180px', padding: '0.48rem 0.7rem', borderRadius: '8px', border: '1px solid #cbd5e1' }} />
                <input type="text" placeholder="When / Client Cue" value={pbCue} onChange={(e) => setPbCue(e.target.value)} style={{ flex: '1 1 180px', padding: '0.48rem 0.7rem', borderRadius: '8px', border: '1px solid #cbd5e1' }} />
              </div>
              <textarea rows={2} placeholder="Exact Hinglish / English response..." value={pbResponse} onChange={(e) => setPbResponse(e.target.value)} required style={{ padding: '0.5rem 0.7rem', borderRadius: '8px', border: '1px solid #cbd5e1' }} />
              <div>
                <button type="submit" className="primary-button" disabled={savingRule} style={{ padding: '0.42rem 0.95rem', fontSize: '0.82rem' }}>
                  {savingRule ? 'Saving...' : 'Save Rule'}
                </button>
              </div>
            </form>
          ) : null}

          <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            {['', 'discovery', 'objection', 'whatsapp_template', 'red_flag'].map((cat) => (
              <button
                key={cat || 'all'}
                type="button"
                className={pbFilter === cat ? 'primary-button' : 'ghost-button'}
                onClick={() => setPbFilter(cat)}
                style={{ padding: '0.32rem 0.75rem', fontSize: '0.78rem' }}
              >
                {cat ? CATEGORY_LABELS[cat] : `All (${playbook.length})`}
              </button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '0.85rem' }}>
            {filteredPlaybook.map((rule) => (
              <div key={rule.id} style={subCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div>
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '0.18rem 0.55rem', borderRadius: '999px', background: rule.category === 'red_flag' ? '#fee2e2' : '#dbeafe', color: rule.category === 'red_flag' ? '#991b1b' : '#1e40af' }}>
                      {CATEGORY_LABELS[rule.category] || rule.category}
                    </span>
                    <div style={{ fontWeight: 700, fontSize: '0.94rem', color: '#0f172a', marginTop: '0.35rem' }}>{rule.title}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.3rem' }}>
                    <button type="button" className="ghost-button" onClick={() => handleCopy(rule.ideal_response, rule.id)} style={{ padding: '0.22rem 0.5rem', fontSize: '0.74rem' }}>
                      {copiedId === rule.id ? '✅' : '📋'}
                    </button>
                    <button type="button" className="ghost-button" onClick={() => handleDeleteRule(rule.id)} style={{ padding: '0.22rem 0.5rem', fontSize: '0.74rem', color: '#ef4444' }}>
                      ✕
                    </button>
                  </div>
                </div>
                {rule.client_cue ? <div style={{ fontSize: '0.79rem', color: '#64748b' }}><strong>When:</strong> {rule.client_cue}</div> : null}
                <div style={{ fontSize: '0.86rem', color: '#1e293b', lineHeight: 1.48, background: '#f8fafc', padding: '0.6rem 0.8rem', borderRadius: '8px' }}>
                  "{rule.ideal_response}"
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ============================================================
          TAB 3: AI ROLEPLAY ARENA
      ============================================================ */}
      {!loading && activeTab === 'roleplay' ? (
        <section style={panelStyle}>
          <div style={{ marginBottom: '1rem' }}>
            <h3 style={{ margin: '0 0 0.2rem 0', fontSize: '1.1rem', color: '#0f172a' }}>AI Roleplay &amp; Objection Practice</h3>
            <p style={{ margin: 0, fontSize: '0.84rem', color: '#64748b' }}>
              Pick a realistic Climeto client scenario below and practice handling tough objections live with Gemini AI.
            </p>
          </div>

          {!activeRoleplay ? (
            <>
              <div style={{ marginBottom: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                <label style={{ fontSize: '0.84rem', fontWeight: 600, color: '#334155' }}>Your Name:</label>
                <input
                  type="text"
                  placeholder="Enter Executive Name (e.g. Jay, Abhishek, Sahil)"
                  value={rpExecName}
                  onChange={(e) => setRpExecName(e.target.value)}
                  style={{ padding: '0.48rem 0.75rem', borderRadius: '8px', border: '1px solid #cbd5e1', width: '280px' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.85rem' }}>
                {(roleplayData.scenarios || []).map((sc) => (
                  <div key={sc.id} style={subCardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '0.18rem 0.55rem', borderRadius: '999px', background: sc.difficulty === 'Hard' ? '#fee2e2' : sc.difficulty === 'Medium' ? '#fef3c7' : '#dcfce7', color: sc.difficulty === 'Hard' ? '#991b1b' : sc.difficulty === 'Medium' ? '#92400e' : '#166534' }}>
                        {sc.difficulty}
                      </span>
                    </div>
                    <strong style={{ fontSize: '0.95rem', color: '#0f172a' }}>{sc.title}</strong>
                    <p style={{ margin: 0, fontSize: '0.82rem', color: '#475569', lineHeight: 1.45 }}>
                      "{sc.openingMessage}"
                    </p>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={rpBusy}
                      onClick={() => handleStartRoleplay(sc.id)}
                      style={{ marginTop: 'auto', padding: '0.45rem 0.85rem', fontSize: '0.82rem' }}
                    >
                      🎯 Start This Drill
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={subCardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.7rem' }}>
                <div>
                  <strong style={{ fontSize: '1rem', color: '#0f172a' }}>{activeRoleplay.scenario_title}</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>Executive: {activeRoleplay.executive_name}</div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {activeRoleplay.status === 'active' ? (
                    <button type="button" className="primary-button" disabled={rpBusy} onClick={handleFinishRoleplay} style={{ padding: '0.38rem 0.85rem', fontSize: '0.8rem' }}>
                      🏁 Finish &amp; Score
                    </button>
                  ) : null}
                  <button type="button" className="ghost-button" onClick={() => setActiveRoleplay(null)} style={{ padding: '0.38rem 0.8rem', fontSize: '0.8rem' }}>
                    ← All Scenarios
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', maxHeight: '340px', overflowY: 'auto', padding: '0.25rem 0' }}>
                {(activeRoleplay.messages || []).map((m, idx) => (
                  <div
                    key={idx}
                    style={{
                      alignSelf: m.role === 'executive' ? 'flex-end' : 'flex-start',
                      maxWidth: '80%',
                      background: m.role === 'executive' ? '#eff6ff' : '#f0fdf4',
                      border: m.role === 'executive' ? '1px solid #bfdbfe' : '1px solid #bbf7d0',
                      padding: '0.65rem 0.9rem',
                      borderRadius: '12px',
                      fontSize: '0.87rem',
                      lineHeight: 1.45,
                    }}
                  >
                    <strong style={{ fontSize: '0.74rem', display: 'block', marginBottom: '0.2rem', color: '#475569' }}>
                      {m.role === 'executive' ? `🧑‍💼 ${activeRoleplay.executive_name}` : '🏢 AI Client'}
                    </strong>
                    {m.text}
                  </div>
                ))}
              </div>

              {activeRoleplay.status === 'active' ? (
                <form onSubmit={handleSendRoleplayMessage} style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="text"
                    placeholder="Type your Hinglish / English pitch reply..."
                    value={rpInput}
                    onChange={(e) => setRpInput(e.target.value)}
                    disabled={rpBusy}
                    style={{ flex: 1, padding: '0.55rem 0.8rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                  />
                  <button type="submit" className="primary-button" disabled={rpBusy} style={{ padding: '0.5rem 1rem' }}>
                    {rpBusy ? 'Thinking...' : 'Send'}
                  </button>
                </form>
              ) : null}

              {activeRoleplay.score ? (
                <div style={{ padding: '0.9rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                    <strong style={{ color: '#14532d' }}>🎯 Drill Coaching Scorecard</strong>
                    <span className="pill good">Score: {activeRoleplay.score.overall_score} / 10</span>
                  </div>
                  <p style={{ margin: '0.25rem 0', fontSize: '0.87rem', color: '#1e293b' }}>{activeRoleplay.score.verdict}</p>
                  {activeRoleplay.score.best_rebuttal ? (
                    <div style={{ marginTop: '0.55rem', padding: '0.6rem 0.8rem', background: '#ffffff', borderRadius: '8px', fontSize: '0.85rem' }}>
                      <strong>💬 Best Rebuttal Line:</strong> "{activeRoleplay.score.best_rebuttal}"
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {/* ============================================================
          TAB 4: EPR KNOWLEDGE BASE (PDF / WORD / ZIP / RAR)
      ============================================================ */}
      {!loading && activeTab === 'knowledge' ? (
        <section style={panelStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
            <div>
              <h3 style={{ margin: '0 0 0.2rem 0', fontSize: '1.1rem', color: '#0f172a' }}>EPR Knowledge Base</h3>
              <p style={{ margin: 0, fontSize: '0.84rem', color: '#64748b' }}>
                Upload Climeto's official EPR / CPCB guides so Gemini AI fact-checks every executive pitch accurately.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
              <label
                className="primary-button"
                style={{ padding: '0.48rem 0.95rem', fontSize: '0.84rem', cursor: uploadingDocs ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
              >
                {uploadingDocs ? '⏳ Extracting...' : '📄 Upload PDF / Word / ZIP / RAR'}
                <input
                  type="file"
                  multiple
                  accept=".pdf,.docx,.zip,.rar,.txt,.md"
                  disabled={uploadingDocs}
                  onChange={handleUploadKnowledgeFiles}
                  style={{ display: 'none' }}
                />
              </label>
              <button
                type="button"
                className="ghost-button"
                disabled={generatingRules || knowledgeDocs.length === 0}
                onClick={handleGeneratePlaybookFromDocs}
                style={{ padding: '0.48rem 0.9rem', fontSize: '0.84rem' }}
              >
                {generatingRules ? '⏳ Generating...' : '✨ Auto-Generate Playbook Rules'}
              </button>
            </div>
          </div>

          <div style={{ background: '#f8fafc', border: '1px dashed #94a3b8', borderRadius: '12px', padding: '0.85rem 1rem', marginBottom: '1rem', fontSize: '0.83rem', color: '#475569' }}>
            <strong>Supported:</strong> <code>.pdf</code>, <code>.docx</code> (Word), <code>.zip</code> &amp; <code>.rar</code> (auto-extracts files inside), <code>.txt</code> / <code>.md</code> (up to 25 MB each).
          </div>

          {knowledgeDocs.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '0.85rem' }}>
              {knowledgeDocs.map((doc) => (
                <div key={doc.id} style={{ ...subCardStyle, opacity: doc.is_active ? 1 : 0.6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '0.18rem 0.5rem', borderRadius: '999px', background: '#dbeafe', color: '#1e40af', textTransform: 'uppercase' }}>
                        {doc.file_type}
                      </span>
                      <div style={{ fontWeight: 700, fontSize: '0.94rem', color: '#0f172a', marginTop: '0.3rem' }}>{doc.title}</div>
                      <div style={{ fontSize: '0.76rem', color: '#64748b', marginTop: '0.1rem' }}>
                        {doc.filename}{doc.source_zip ? ` · ${doc.source_zip}` : ''} · {Number(doc.char_count || 0).toLocaleString()} chars
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
                      <button type="button" className="ghost-button" onClick={() => handleToggleDoc(doc)} style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem' }}>
                        {doc.is_active ? '🟢 Active' : '⚪ Paused'}
                      </button>
                      <button type="button" className="ghost-button" onClick={() => handleDeleteDoc(doc.id)} style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', color: '#ef4444' }}>
                        ✕
                      </button>
                    </div>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.83rem', color: '#334155', lineHeight: 1.45 }}>{doc.summary}...</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="status-card muted">
              No EPR documents uploaded yet. Click <strong>"📄 Upload PDF / Word / ZIP / RAR"</strong> above!
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}
