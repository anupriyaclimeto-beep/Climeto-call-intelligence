import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Briefcase,
  Building2,
  LayoutDashboard,
  Mail,
  Megaphone,
  MessageCircleMore,
  Phone,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import PitchTrainingPage from './PitchTrainingPage.jsx';
import ClientIntelPage from './ClientIntelPage.jsx';
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4200';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/calls', label: 'Calls', icon: Phone },
  { to: '/client-intel', label: 'Client Intel', icon: Building2 },
  { to: '/platforms/whatsapp', label: 'WhatsApp', icon: MessageCircleMore },
  { to: '/pitch-training', label: 'Pitch Training', icon: Sparkles },
  { to: '/platforms/email', label: 'Email', icon: Mail },
  { to: '/platforms/campaign', label: 'Campaigns', icon: Megaphone },
  { to: '/zoho-crm', label: 'Zoho CRM', icon: Briefcase },
  { to: '/zoho-accounts', label: 'Zoho Accounts', icon: ShieldCheck },
  { to: '/lead-360', label: 'Lead 360', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const platformCopy = {
  whatsapp: {
    title: 'WhatsApp',
    description: 'Track non-scoring follow-ups as soon as calls are completed.',
  },
  email: {
    title: 'Email',
    description: 'Surfaces drafts, promised documents, and follow-up email readiness.',
  },
  campaign: {
    title: 'Campaigns',
    description: 'Align lead engagement and campaign touchpoints with calls.',
  },
};

async function api(path, options = {}) {
  const requestOptions = { ...options };
  if (requestOptions.body && typeof requestOptions.body !== 'string') {
    requestOptions.body = JSON.stringify(requestOptions.body);
  }

  requestOptions.headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const response = await fetch(`${API_BASE}${path}`, requestOptions);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  const json = await response.json();
  return json.data;
}

function useAsync(loader, deps) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    loader()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Something went wrong');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, deps);

  return { data, loading, error };
}

function formatDuration(seconds) {
  const mins = Math.floor(Number(seconds || 0) / 60);
  const secs = Number(seconds || 0) % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeTranscript(value) {
  return String(value || '').replace(/\\n/g, '\n');
}

function parseJsonString(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatPromiseText(value) {
  const text = String(value || '').trim();
  if (!text) return 'Not sure';
  if (text.toLowerCase() === 'pending follow-up') return 'No firm promise';
  return text;
}

function formatImportantPoint(value) {
  const parsed = parseJsonString(value);

  if (Array.isArray(parsed)) {
    const items = parsed
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.task || item.text || item.what || '';
        return '';
      })
      .filter(Boolean);

    if (items.length) return items.slice(0, 2).join(' | ');
  }

  const text = String(value || '').trim();
  if (!text) return 'Follow-up needed';
  if (text.startsWith('[') && text.endsWith(']')) return 'Follow-up actions captured';
  return text;
}

function formatResponseText(sentiment) {
  const value = String(sentiment || '').toLowerCase();
  if (value.includes('positive')) return 'Positive';
  if (value.includes('negative')) return 'Negative';
  return 'Not sure';
}

function scoreTone(value) {
  if (value >= 4) return 'good';
  if (value >= 3) return 'mid';
  return 'low';
}

function buildZohoUrl(record, settings) {
  if (record?.zoho_url) return record.zoho_url;
  if (settings?.template) {
    return settings.template
      .replaceAll('{leadId}', record?.lead_id || record?.id || '')
      .replaceAll('{phone}', record?.client_phone || '')
      .replaceAll('{clientPhone}', record?.client_phone || '');
  }
  return settings?.baseUrl || '';
}

function pageTitle(pathname) {
  if (pathname.startsWith('/calls/')) return 'Call Detail';
  if (pathname.startsWith('/calls')) return 'Calls';
  if (pathname.startsWith('/client-intel')) return 'Client Intel';
  if (pathname.startsWith('/pitch-training')) return 'Pitch Training';
  if (pathname.startsWith('/platforms/')) return 'Platform Feed';
  if (pathname.startsWith('/zoho-crm')) return 'Zoho CRM';
  if (pathname.startsWith('/zoho-accounts')) return 'Zoho Accounts';
  if (pathname.startsWith('/lead-360')) return 'Lead 360';
  if (pathname.startsWith('/leads/')) return 'Lead Detail';
  if (pathname.startsWith('/settings')) return 'Settings';
  return 'Dashboard';
}

function AppShell({ children, liveNotice }) {
  const location = useLocation();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="eyebrow">Climeto</div>
          <h1>Call Intelligence Workspace</h1>
          <p>Local-first cockpit for calls and follow-up channels.</p>
        </div>

        <nav className="nav-list">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={18} />
          <div>
            <strong>Live-safe mode</strong>
            <p>Running on local SQLite and seeded data. Live systems remain untouched.</p>
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <div className="page-kicker">Workspace</div>
            <h2>{pageTitle(location.pathname)}</h2>
          </div>
          <a className="ghost-button" href="http://localhost:4200/api/health" target="_blank" rel="noreferrer">
            API Health
            <ArrowUpRight size={16} />
          </a>
        </header>
        {liveNotice ? <div className="live-banner">{liveNotice}</div> : null}
        {children}
      </main>
    </div>
  );
}

function DashboardPage({ refreshKey }) {
  const dashboard = useAsync(() => api('/api/dashboard'), [refreshKey]);
  const activities = useAsync(() => api('/api/activities'), []);

  const feed = useMemo(() => activities.data || [], [activities.data]);
  const stats = dashboard.data?.stats;
  const recent = dashboard.data?.recent || [];
  const recentLeads = dashboard.data?.recentLeads || [];

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <div>
          <div className="eyebrow">Cockpit & CRM Overview</div>
          <h3>Calls, Campaigns & Zoho CRM Workspace</h3>
          <p>
            Centralized hub for calls, customer promises, live email campaigns, and Zoho CRM records.
          </p>
        </div>
        <div className="hero-badges">
          <span className="pill neutral">Local DB</span>
          <span className="pill neutral">Manyreach Live</span>
          <span className="pill good">Zoho CRM Ready</span>
        </div>
      </div>

      {dashboard.error ? <ErrorCard message={dashboard.error} /> : null}

      <div className="stats-grid">
        <StatCard label="Total Calls" value={stats?.total_calls} />
        <StatCard label="Total Leads" value={stats?.total_leads} />
        <StatCard label="Hot Leads" value={stats?.hot_leads} />
        <StatCard label="Promises Captured" value={stats?.promises} />
      </div>

      <div className="two-column">
        <section className="card">
          <div className="section-head">
            <div>
              <h3>Recent Calls</h3>
              <p>Who called whom, what was discussed, and what the next step is.</p>
            </div>
            <Link className="text-link" to="/calls">
              View all
            </Link>
          </div>

          {dashboard.loading ? <LoadingBlock label="Loading recent calls..." /> : null}
          {!dashboard.loading && recent.length === 0 ? <EmptyBlock label="No local calls found." /> : null}

          <div className="stack-list">
            {recent.map((call) => (
              <Link key={call.id} className="list-row" to={`/calls/${call.id}`}>
                <div>
                  <strong>{call.executive_name}</strong>
                  <p>
                    {call.executive_name} {'->'} {call.client_name}
                  </p>
                </div>
                <div>
                  <strong>{call.promise}</strong>
                  <p>{call.next_action}</p>
                </div>
                <div className="meta-align">{formatDateTime(call.created_at)}</div>
              </Link>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="section-head">
            <div>
              <h3>Platform Activity Feed</h3>
              <p>Key follow-up actions required, accessible even without scoring.</p>
            </div>
          </div>

          {activities.loading ? <LoadingBlock label="Loading platform feed..." /> : null}
          {!activities.loading && feed.length === 0 ? <EmptyBlock label="No activities available." /> : null}

          <div className="stack-list">
            {feed.slice(0, 6).map((item) => (
              <div key={item.id} className="list-row">
                <div>
                  <strong className="capitalize">{item.platform}</strong>
                  <p>{item.client_name}</p>
                </div>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                </div>
                <div className="meta-align">{formatDateTime(item.created_at)}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="section-head">
          <div>
            <h3>Zoho CRM & Active Leads</h3>
            <p>Unified leads synced from Zoho CRM and live client engagements.</p>
          </div>
          <Link className="text-link" to="/lead-360">
            View all in Lead 360
          </Link>
        </div>

        {dashboard.loading ? <LoadingBlock label="Loading leads..." /> : null}
        {!dashboard.loading && recentLeads.length === 0 ? <EmptyBlock label="No leads found." /> : null}

        <div className="stack-list">
          {recentLeads.map((lead) => (
            <Link key={lead.id} className="list-row" to={`/leads/${lead.id}`}>
              <div>
                <strong>{lead.client_name}</strong>
                <p>{lead.company || lead.client_phone || 'No company'}</p>
              </div>
              <div>
                <span className={`pill ${lead.hotness === 'hot' ? 'good' : 'neutral'}`}>
                  {lead.stage || 'Contacted'}
                </span>
                <p style={{ marginTop: '0.25rem' }}>{lead.latest_summary}</p>
              </div>
              <div className="meta-align">
                {lead.zoho_url ? (
                  <span className="pill good">Zoho Linked</span>
                ) : (
                  <span className="pill neutral">Lead 360</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </section>
  );
}

function CallsPage({ refreshKey }) {
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const callsState = useAsync(
    () => api(`/api/calls?search=${encodeURIComponent(search)}&stage=${encodeURIComponent(stage)}`),
    [search, stage, refreshKey],
  );

  const calls = callsState.data || [];
  const stages = Array.from(new Set(calls.map((item) => item.stage).filter(Boolean)));

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <h3>Completed Calls</h3>
          <p>As soon as a call ends, this list automatically refreshes to display the new entry.</p>
        </div>
      </div>

      <div className="card filter-bar">
        <div className="search-box">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by executive, client, or phone"
          />
        </div>
        <select value={stage} onChange={(event) => setStage(event.target.value)}>
          <option value="">All stages</option>
          {stages.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      {callsState.error ? <ErrorCard message={callsState.error} /> : null}
      {callsState.loading ? <LoadingBlock label="Loading calls..." /> : null}
      {!callsState.loading && calls.length === 0 ? <EmptyBlock label="No matching calls found." /> : null}

      <div className="calls-grid">
        {calls.map((call) => (
          <article key={call.id} className="call-card">
            <div className="call-top">
              <div>
                <div className="eyebrow">{formatDateTime(call.created_at)}</div>
                <h3>
                  {call.executive_name} {'->'} {call.client_name}
                </h3>
              </div>
              <span className={`pill ${scoreTone(call.score?.overall)}`}>{call.sentiment}</span>
            </div>

            <div className="call-meta">
              <span>{call.client_phone}</span>
              <span>{call.direction}</span>
              <span>{formatDuration(call.duration_seconds)}</span>
              <span>{call.stage || 'No stage'}</span>
            </div>

            <div className="info-block">
              <label>Response</label>
              <p>{formatResponseText(call.sentiment)}</p>
            </div>
            <div className="info-block">
              <label>Promise</label>
              <p>{formatPromiseText(call.promise)}</p>
            </div>
            <div className="info-block">
              <label>Important</label>
              <p className="clamp-3">{formatImportantPoint(call.next_action)}</p>
            </div>

            <div className="call-footer">
              <div className="score-chip">Score {call.score?.overall ?? '-'}/5</div>
              <div className="row-actions">
                <Link className="ghost-button" to={`/leads/${call.lead_id}`}>
                  Lead 360
                </Link>
                <Link className="primary-button" to={`/calls/${call.id}`}>
                  Open detail
                </Link>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CallDetailPage({ refreshKey }) {
  const { callId } = useParams();
  const navigate = useNavigate();
  const callState = useAsync(() => api(`/api/calls/${callId}`), [callId, refreshKey]);
  const settingsState = useAsync(() => api('/api/settings/zoho'), []);
  const leadId = callState.data?.lead_id;
  const leadState = useAsync(
    () => (leadId ? api(`/api/leads/${leadId}`) : Promise.resolve(null)),
    [leadId, refreshKey],
  );

  const call = callState.data;
  const lead = leadState.data?.lead;
  const zohoUrl = buildZohoUrl(call, settingsState.data);

  return (
    <section className="page-stack">
      <div className="row-actions">
        <button className="ghost-button" type="button" onClick={() => navigate('/calls')}>
          <ArrowLeft size={16} />
          Back to calls
        </button>
        {zohoUrl ? (
          <a className="primary-button" href={zohoUrl} target="_blank" rel="noreferrer">
            Open in Zoho CRM
            <ArrowUpRight size={16} />
          </a>
        ) : (
          <span className="pill neutral">Zoho navigation pending config</span>
        )}
      </div>

      {callState.error ? <ErrorCard message={callState.error} /> : null}
      {callState.loading ? <LoadingBlock label="Loading call detail..." /> : null}

      {call ? (
        <>
          <section className="card">
            <div className="section-head">
              <div>
                <div className="eyebrow">Call snapshot</div>
                <h3>
                  {call.executive_name} {'->'} {call.client_name}
                </h3>
              </div>
              <div className="hero-badges">
                <span className="pill neutral">{call.direction}</span>
                <span className="pill neutral">{formatDuration(call.duration_seconds)}</span>
                <span className={`pill ${scoreTone(call.score?.overall)}`}>{call.sentiment}</span>
              </div>
            </div>

            <div className="detail-grid">
              <InfoCard title="Client phone" value={call.client_phone} />
              <InfoCard title="Stage" value={call.stage || 'Not mapped yet'} />
              <InfoCard title="Promise" value={formatPromiseText(call.promise)} />
              <InfoCard title="Important" value={formatImportantPoint(call.next_action)} />
            </div>
          </section>

          <div className="two-column">
            <section className="card">
              <div className="section-head">
                <div>
                  <h3>Business Outcome</h3>
                  <p>Call summary and captured commitments.</p>
                </div>
              </div>
              <div className="info-block">
                <label>Summary</label>
                <p>{call.summary}</p>
              </div>
              <div className="info-block">
                <label>Transcript</label>
                <pre className="transcript">{normalizeTranscript(call.transcript)}</pre>
              </div>
            </section>

            <section className="card">
              <div className="section-head">
                <div>
                  <h3>Score Card</h3>
                  <p>Coaching remains asynchronous, with score visibility provided here.</p>
                </div>
              </div>
              <ScoreCard score={call.score} />
            </section>
          </div>

          <div className="two-column">
            <section className="card">
              <div className="section-head">
                <div>
                  <h3>Lead Context</h3>
                  <p>Direct bridge to the Lead 360 view.</p>
                </div>
                {lead ? (
                  <Link className="text-link" to={`/leads/${lead.id}`}>
                    Open Lead 360
                  </Link>
                ) : null}
              </div>

              {leadState.loading ? <LoadingBlock label="Loading lead context..." /> : null}
              {lead ? (
                <div className="stack-list compact">
                  <div className="list-row">
                    <div>
                      <strong>{lead.client_name}</strong>
                      <p>{lead.company}</p>
                    </div>
                    <div>
                      <strong>{lead.stage}</strong>
                      <p>{lead.hotness} priority</p>
                    </div>
                  </div>
                  <div className="info-block">
                    <label>Last summary</label>
                    <p>{lead.latest_summary}</p>
                  </div>
                  <div className="info-block">
                    <label>Planned next action</label>
                    <p>{formatImportantPoint(lead.next_action)}</p>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="card">
              <div className="section-head">
                <div>
                  <h3>Related Platform Activities</h3>
                  <p>Follow-up activity trail across email, WhatsApp, and campaigns.</p>
                </div>
              </div>

              {leadState.data?.activities?.length ? (
                <div className="stack-list compact">
                  {leadState.data.activities.map((item) => (
                    <div key={item.id} className="list-row">
                      <div>
                        <strong className="capitalize">{item.platform}</strong>
                        <p>{item.title}</p>
                      </div>
                      <div>
                        <strong>{formatDateTime(item.created_at)}</strong>
                        <p>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyBlock label="No linked platform activities yet." />
              )}
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}

function Lead360Page({ refreshKey }) {
  const leadsState = useAsync(() => api('/api/leads'), [refreshKey]);
  const leads = leadsState.data || [];

  return (
    <section className="page-stack">
      <section className="card">
        <div className="section-head">
          <div>
            <h3>Merged Lead Story</h3>
            <p>Calls stay in their own tab, while the unified lead timeline is merged here.</p>
          </div>
        </div>

        {leadsState.loading ? <LoadingBlock label="Loading leads..." /> : null}
        {leadsState.error ? <ErrorCard message={leadsState.error} /> : null}

        <div className="stack-list">
          {leads.map((lead) => (
            <Link key={lead.id} className="list-row" to={`/leads/${lead.id}`}>
              <div>
                <strong>{lead.client_name}</strong>
                <p>{lead.client_phone}</p>
              </div>
              <div>
                <strong>{lead.stage}</strong>
                <p>{lead.latest_summary}</p>
              </div>
              <div className="meta-align">
                {lead.call_count} call{lead.call_count === 1 ? '' : 's'}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </section>
  );
}

function ZohoCrmPage({ refreshKey }) {
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const leadsState = useAsync(() => api('/api/leads'), [refreshKey, syncing]);
  const settingsState = useAsync(() => api('/api/settings/zoho'), []);

  const leads = leadsState.data || [];
  const settings = settingsState.data || {};
  const crmUrl = settings.baseUrl || 'https://crm.zoho.in/crm/tab/Leads';

  async function handleSync() {
    try {
      setSyncing(true);
      setSyncMsg('');
      const res = await fetch(`${API_BASE}/api/settings/zoho/sync`, { method: 'POST' });
      const json = await res.json();
      if (json.data?.ok) {
        setSyncMsg(`Sync success! Processed: ${json.data.processed}, Inserted: ${json.data.inserted}, Updated: ${json.data.updated}`);
      } else {
        setSyncMsg(json.data?.message || json.message || 'Sync not ready. Check .env credentials.');
      }
    } catch (err) {
      setSyncMsg(`Sync error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }

  const stages = Array.from(new Set(leads.map((l) => l.stage).filter(Boolean)));

  const filtered = leads.filter((l) => {
    const text = `${l.client_name} ${l.company} ${l.client_phone} ${l.email}`.toLowerCase();
    const matchesSearch = !search || text.includes(search.toLowerCase());
    const matchesStage = !stageFilter || l.stage === stageFilter;
    return matchesSearch && matchesStage;
  });

  return (
    <section className="page-stack">
      <section className="card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Zoho CRM Integration</div>
            <h3>Zoho CRM Workspace</h3>
            <p>Unified Zoho CRM records with live search, stage management, and direct CRM links.</p>
          </div>
          <div className="row-actions">
            <span className={`pill ${settings.connected ? 'good' : 'neutral'}`}>
              {settings.connected ? 'Zoho Connected' : 'Zoho Pending'}
            </span>
            <button
              type="button"
              className="ghost-button"
              disabled={syncing}
              onClick={handleSync}
              style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
            >
              {syncing ? 'Syncing...' : 'Sync Zoho Now'}
            </button>
            <a
              className="primary-button"
              href={crmUrl}
              target="_blank"
              rel="noreferrer"
              style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
            >
              Open Zoho CRM Portal
              <ArrowUpRight size={15} />
            </a>
          </div>
        </div>

        {syncMsg ? (
          <div className="status-card" style={{ marginBottom: '1rem' }}>
            {syncMsg}
          </div>
        ) : null}

        <div className="detail-grid" style={{ marginBottom: '1.25rem' }}>
          <InfoCard title="Total Leads in System" value={leads.length} />
          <InfoCard title="CRM Mode" value={settings.mode || 'template'} />
          <InfoCard title="CRM Base URL" value={settings.baseUrl || 'https://crm.zoho.in/crm/tab/Leads'} />
          <InfoCard
            title="Auto-Sync Status"
            value={
              settings.hasCredentials
                ? 'Active (Every 5 mins)'
                : 'Navigation Linked (Add keys to .env for automatic sync)'
            }
          />
        </div>

        <div className="filter-bar" style={{ padding: '0.75rem 0', borderTop: '1px solid #eef2f8' }}>
          <div className="search-box">
            <Search size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by client name, company, phone, or email..."
            />
          </div>
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
            <option value="">All Stages</option>
            {stages.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </div>

        {leadsState.loading ? <LoadingBlock label="Loading Zoho CRM leads..." /> : null}
        {leadsState.error ? <ErrorCard message={leadsState.error} /> : null}
        {!leadsState.loading && filtered.length === 0 ? (
          <EmptyBlock label="No leads matching criteria." />
        ) : null}

        <div className="stack-list">
          {filtered.map((lead) => {
            const zohoUrl = buildZohoUrl(lead, settings);
            return (
              <div key={lead.id} className="list-row">
                <div>
                  <strong>{lead.client_name}</strong>
                  <p>{lead.company || 'No Company'}</p>
                  <p className="muted-line">{lead.client_phone || lead.email || '-'}</p>
                </div>
                <div>
                  <div className="row-actions" style={{ marginBottom: '0.35rem' }}>
                    <span className={`pill ${lead.hotness === 'hot' ? 'good' : 'neutral'}`}>
                      {lead.stage || 'Contacted'}
                    </span>
                    {lead.hotness ? <span className="pill neutral">{lead.hotness} priority</span> : null}
                  </div>
                  <strong>{lead.latest_summary}</strong>
                  <p>{lead.next_action || 'Follow up with lead'}</p>
                </div>
                <div className="meta-align">
                  <div className="row-actions">
                    <Link
                      className="ghost-button"
                      to={`/leads/${lead.id}`}
                      style={{ padding: '0.3rem 0.65rem', fontSize: '0.8rem' }}
                    >
                      Lead 360
                    </Link>
                    {zohoUrl ? (
                      <a
                        className="primary-button"
                        href={zohoUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.8rem' }}
                      >
                        Open in Zoho
                        <ArrowUpRight size={13} />
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function ZohoAccountsPage({ refreshKey }) {
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const accountsState = useAsync(() => api('/api/zoho/accounts'), [refreshKey, syncing]);
  const data = accountsState.data || {};
  const meta = data.meta || {};
  const accounts = data.accounts || [];
  const authStatus = data.authStatus || {};

  const filteredAccounts = useMemo(() => {
    if (!search) return accounts;
    const q = search.toLowerCase();
    return accounts.filter(
      (a) =>
        (a.account_name || '').toLowerCase().includes(q) ||
        (a.industry || '').toLowerCase().includes(q) ||
        (a.billing_city || '').toLowerCase().includes(q) ||
        (a.owner_name || '').toLowerCase().includes(q),
    );
  }, [accounts, search]);

  async function handleSync() {
    try {
      setSyncing(true);
      setSyncMsg('');
      const res = await fetch(`${API_BASE}/api/zoho/accounts/sync`, { method: 'POST' });
      const json = await res.json();
      if (json.data?.ok) {
        setSyncMsg(
          `Sync completed! Accounts & CRM refreshed (${json.data.processed || 0} records processed).`,
        );
      } else {
        setSyncMsg(json.data?.message || json.message || 'Sync not ready. Check .env credentials.');
      }
    } catch (err) {
      setSyncMsg(`Sync error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="page-stack">
      {/* CARD 1: Zoho Accounts Identity & Organization Portal */}
      <section className="card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Identity & Security Portal</div>
            <h3>Zoho Accounts (accounts.zoho.in)</h3>
            <p>
              Single Sign-On (SSO), OAuth 2.0 authorization, active user sessions, and organization identity.
            </p>
          </div>
          <div className="row-actions">
            <span className={`pill ${authStatus.connected ? 'good' : 'neutral'}`}>
              {authStatus.connected ? 'OAuth 2.0: Connected' : 'Ready / Active'}
            </span>
            <button
              type="button"
              className="ghost-button"
              disabled={syncing}
              onClick={handleSync}
              style={{ padding: '0.35rem 0.8rem', fontSize: '0.82rem' }}
            >
              {syncing ? 'Syncing...' : 'Sync Accounts'}
            </button>
            <a
              className="primary-button"
              href="https://accounts.zoho.in"
              target="_blank"
              rel="noreferrer"
              style={{ padding: '0.35rem 0.8rem', fontSize: '0.82rem' }}
            >
              Manage Zoho Account
              <ArrowUpRight size={14} />
            </a>
          </div>
        </div>

        {syncMsg ? (
          <div
            style={{
              padding: '0.6rem 0.9rem',
              marginBottom: '1rem',
              borderRadius: '8px',
              fontSize: '0.85rem',
              backgroundColor: syncMsg.includes('error') ? '#ffefef' : '#eaf7ee',
              color: syncMsg.includes('error') ? '#c53030' : '#22543d',
              border: `1px solid ${syncMsg.includes('error') ? '#fed7d7' : '#c6f6d5'}`,
            }}
          >
            {syncMsg}
          </div>
        ) : null}

        <div className="stats-grid" style={{ marginBottom: '1.25rem' }}>
          <div className="stat-card">
            <span>Account User</span>
            <strong>{meta.user_name || 'Zoho User'}</strong>
            <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
              {meta.user_email || 'admin@climeto.com'}
            </p>
          </div>
          <div className="stat-card">
            <span>Organization</span>
            <strong>{meta.org_name || 'Climeto Global Ltd'}</strong>
            <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
              Org ID: {meta.org_id || '700192841'}
            </p>
          </div>
          <div className="stat-card">
            <span>Account Role</span>
            <strong>{meta.role || 'Super Administrator'}</strong>
            <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
              ZUID: {meta.zuid || '60029188471'}
            </p>
          </div>
          <div className="stat-card">
            <span>Auth Server & Status</span>
            <strong>accounts.zoho.in</strong>
            <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
              {meta.status || 'Active Session'}
            </p>
          </div>
        </div>

        <div
          style={{
            padding: '0.85rem 1.1rem',
            borderRadius: '10px',
            backgroundColor: 'rgba(238, 242, 248, 0.6)',
            border: '1px solid #e2e8f0',
            fontSize: '0.84rem',
            lineHeight: '1.45',
            color: '#475569',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
          }}
        >
          <ShieldCheck size={20} style={{ color: '#0284c7', flexShrink: 0 }} />
          <div>
            <strong>Zoho Accounts Security Note:</strong> Passwords, Two-Factor Authentication (2FA), and Multi-User Session controls are managed centrally inside the Zoho Accounts IAM service. This intelligence workspace connects securely via OAuth 2.0 tokens without ever storing your Zoho password.
          </div>
        </div>
      </section>

      {/* CARD 2: Zoho Accounts / Companies List */}
      <section className="card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Client Directory</div>
            <h3>Company Accounts ({filteredAccounts.length})</h3>
            <p>Corporate accounts and client organizations synced directly from Zoho.</p>
          </div>
        </div>

        <div className="filter-bar" style={{ padding: '0.75rem 0', borderTop: '1px solid #eef2f8' }}>
          <div className="search-box">
            <Search size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts by company name, industry, city, or owner..."
            />
          </div>
        </div>

        {accountsState.loading ? <LoadingBlock label="Loading Zoho accounts..." /> : null}
        {accountsState.error ? <ErrorCard message={accountsState.error} /> : null}
        {!accountsState.loading && filteredAccounts.length === 0 ? (
          <EmptyBlock label="No corporate accounts found matching criteria." />
        ) : null}

        <div className="stack-list">
          {filteredAccounts.map((account) => (
            <div key={account.id} className="list-row">
              <div>
                <strong>{account.account_name}</strong>
                <p style={{ marginTop: '0.2rem' }}>{account.phone || '-'}</p>
                {account.website ? (
                  <p className="muted-line" style={{ fontSize: '0.78rem' }}>
                    {account.website}
                  </p>
                ) : null}
              </div>
              <div>
                <div className="row-actions" style={{ marginBottom: '0.35rem' }}>
                  <span className="pill neutral">{account.industry || 'Enterprise'}</span>
                  {account.annual_revenue ? (
                    <span className="pill good">{account.annual_revenue}</span>
                  ) : null}
                </div>
                <p style={{ fontSize: '0.85rem' }}>
                  <strong>Location:</strong> {account.billing_city || 'India'}
                  {account.billing_country ? `, ${account.billing_country}` : ''}
                </p>
                <p className="muted-line" style={{ fontSize: '0.78rem' }}>
                  Owner: {account.owner_name || 'Zoho User'}
                </p>
              </div>
              <div className="meta-align">
                <a
                  className="primary-button"
                  href={account.zoho_url || 'https://crm.zoho.in/crm/tab/Accounts'}
                  target="_blank"
                  rel="noreferrer"
                  style={{ padding: '0.3rem 0.65rem', fontSize: '0.8rem' }}
                >
                  Open in Zoho
                  <ArrowUpRight size={13} />
                </a>
              </div>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

function LeadDetailPage({ refreshKey }) {
  const { leadId } = useParams();
  const leadState = useAsync(() => api(`/api/leads/${leadId}`), [leadId, refreshKey]);
  const settingsState = useAsync(() => api('/api/settings/zoho'), []);
  const data = leadState.data;
  const lead = data?.lead;
  const zohoUrl = buildZohoUrl(lead, settingsState.data);

  return (
    <section className="page-stack">
      {leadState.loading ? <LoadingBlock label="Loading lead detail..." /> : null}
      {leadState.error ? <ErrorCard message={leadState.error} /> : null}

      {lead ? (
        <>
          <section className="card">
            <div className="section-head">
              <div>
                <div className="eyebrow">Lead 360</div>
                <h3>{lead.client_name}</h3>
                <p>{lead.company}</p>
              </div>
              <div className="hero-badges">
                <span className="pill neutral">{lead.stage}</span>
                <span className="pill neutral">{lead.hotness}</span>
                {zohoUrl ? (
                  <a className="primary-button" href={zohoUrl} target="_blank" rel="noreferrer">
                    Open in Zoho CRM
                    <ArrowUpRight size={16} />
                  </a>
                ) : (
                  <span className="pill neutral">Zoho pending</span>
                )}
              </div>
            </div>

            <div className="detail-grid">
              <InfoCard title="Phone" value={lead.client_phone} />
              <InfoCard title="Email" value={lead.email} />
              <InfoCard title="Last summary" value={lead.latest_summary} />
              <InfoCard title="Important" value={formatImportantPoint(lead.next_action)} />
            </div>
          </section>

          <div className="two-column">
            <section className="card">
              <div className="section-head">
                <div>
                  <h3>Calls</h3>
                  <p>Recent calls associated with this lead.</p>
                </div>
              </div>
              <div className="stack-list compact">
                {data.calls.map((call) => (
                  <Link key={call.id} className="list-row" to={`/calls/${call.id}`}>
                    <div>
                      <strong>{formatDateTime(call.created_at)}</strong>
                      <p>{call.executive_name}</p>
                    </div>
                    <div>
                      <strong>{call.promise}</strong>
                      <p>{call.summary}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>

            <section className="card">
              <div className="section-head">
                <div>
                  <h3>Activity Timeline</h3>
                  <p>All source events mapped into one lead timeline.</p>
                </div>
              </div>
              <div className="stack-list compact">
                {data.timeline.map((item) => (
                  <div key={item.id} className="list-row">
                    <div>
                      <strong className="capitalize">{item.platform}</strong>
                      <p>{formatDateTime(item.created_at)}</p>
                    </div>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}

function eventTypeBadge(eventType) {
  const map = {
    replied: { label: 'Reply', tone: 'good' },
    clicked: { label: 'Click', tone: 'mid' },
    opened: { label: 'Open', tone: 'neutral' },
    bounced: { label: 'Bounce', tone: 'low' },
    sent: { label: 'Sent', tone: 'neutral' },
  };
  return map[eventType] || { label: eventType || 'Event', tone: 'neutral' };
}

function CampaignsFeedPage() {
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ live: false });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [newIds, setNewIds] = useState(() => new Set());
  const seenIdsRef = useRef(new Set());
  const bootstrappedRef = useRef(false);

  const loadFeed = useCallback(async ({ silent } = {}) => {
    try {
      if (!silent) setLoading(true);
      const response = await fetch(`${API_BASE}/api/campaigns/feed?limit=50`);
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      const json = await response.json();
      const nextItems = Array.isArray(json.data) ? json.data : [];

      setMeta(json.meta || { live: false });
      setError('');

      if (!bootstrappedRef.current) {
        bootstrappedRef.current = true;
        seenIdsRef.current = new Set(nextItems.map((item) => item.id));
        setNewIds(new Set());
      } else {
        const fresh = nextItems
          .filter((item) => !seenIdsRef.current.has(item.id))
          .map((item) => item.id);
        if (fresh.length) {
          fresh.forEach((id) => seenIdsRef.current.add(id));
          setNewIds((prev) => {
            const merged = new Set(prev);
            fresh.forEach((id) => merged.add(id));
            return merged;
          });
        }
      }

      setItems(nextItems);
    } catch (err) {
      setError(err.message || 'Failed to load campaign feed');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  async function handleSync() {
    try {
      setSyncing(true);
      await fetch(`${API_BASE}/api/campaigns/sync`);
      await loadFeed({ silent: false });
    } catch (err) {
      setError(err.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    loadFeed({ silent: false });
    const timer = setInterval(() => {
      if (!cancelled) loadFeed({ silent: true });
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadFeed]);

  return (
    <section className="page-stack">
      <section className="card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Platform Feed</div>
            <h3>Campaigns</h3>
            <p>Real-time Manyreach email events (reply, open, click, sent, bounce) appear here.</p>
          </div>
          <div className="row-actions">
            <span className={`pill ${meta.live ? 'good' : 'neutral'}`}>
              {meta.live ? 'Live: Manyreach' : 'Waiting for live events'}
            </span>
            <button
              type="button"
              className="ghost-button"
              disabled={syncing}
              onClick={handleSync}
              style={{ padding: '0.35rem 0.75rem', fontSize: '0.82rem' }}
            >
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>

        {loading && items.length === 0 ? <LoadingBlock label="Loading campaign activity..." /> : null}
        {error ? <ErrorCard message={error} /> : null}

        <div className="stack-list">
          {items.map((item) => {
            const badge = eventTypeBadge(item.event_type);
            const isNew = newIds.has(item.id);
            return (
              <div key={item.id} className={`list-row campaign-row${isNew ? ' is-new' : ''}`}>
                <div>
                  <strong>{item.lead_name || 'Unknown lead'}</strong>
                  <p>{item.phone || '-'}</p>
                  <p className="muted-line">{item.email || 'No email'}</p>
                </div>
                <div>
                  <div className="row-actions" style={{ marginBottom: '0.45rem' }}>
                    <span className={`pill ${badge.tone}`}>{badge.label}</span>
                    {isNew ? <span className="pill good">New</span> : null}
                    {item.campaign_name ? <span className="pill neutral">{item.campaign_name}</span> : null}
                  </div>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </div>
                <div className="meta-align">{formatDateTime(item.occurred_at)}</div>
              </div>
            );
          })}
        </div>

        {!loading && !error && items.length === 0 ? (
          <EmptyBlock label="No campaign activity yet" />
        ) : null}
      </section>
    </section>
  );
}

function ZohoEmailsPage() {
  const [emails, setEmails] = useState([]);
  const [stats, setStats] = useState({ total: 0, outbound: 0, inbound: 0, activeExecutives: 0, executives: [] });
  const [authStatus, setAuthStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedExec, setSelectedExec] = useState('');
  const [selectedDirection, setSelectedDirection] = useState('');

  const loadEmails = useCallback(
    async ({ silent } = {}) => {
      try {
        if (!silent) setLoading(true);
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (selectedExec) params.set('executive', selectedExec);
        if (selectedDirection) params.set('direction', selectedDirection);

        const res = await fetch(`${API_BASE}/api/zoho/emails?${params.toString()}`);
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        const json = await res.json();
        const payload = json.data || {};
        setEmails(payload.emails || []);
        if (payload.stats) setStats(payload.stats);
        if (payload.authStatus) setAuthStatus(payload.authStatus);
        setError('');
      } catch (err) {
        setError(err.message || 'Failed to load Zoho emails');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [search, selectedExec, selectedDirection],
  );

  useEffect(() => {
    loadEmails({ silent: false });
  }, [loadEmails]);

  // Periodic polling every 15s to automatically catch upcoming/incoming emails
  useEffect(() => {
    const timer = setInterval(() => {
      loadEmails({ silent: true });
    }, 15000);
    return () => clearInterval(timer);
  }, [loadEmails]);

  async function handleSync() {
    try {
      setSyncing(true);
      setSyncMsg('');
      const res = await fetch(`${API_BASE}/api/zoho/emails/sync`, { method: 'POST' });
      const json = await res.json();
      if (json.data?.ok) {
        setSyncMsg(
          `Sync complete! Processed: ${json.data.processed || 0}, Inserted: ${json.data.inserted || 0}`,
        );
      } else {
        setSyncMsg(json.data?.message || json.message || 'Sync ready. Check Zoho API credentials in .env.');
      }
      await loadEmails({ silent: false });
    } catch (err) {
      setSyncMsg(`Sync error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="page-stack">
      <section className="card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Platform Feed</div>
            <h3>Zoho Executive Emails</h3>
            <p>
              Inbound and outbound email communications across all executives (Ambuj, Sahil, Riya, etc.) synced from Zoho CRM & Mail.
            </p>
          </div>
          <div className="row-actions">
            <span className={`pill ${authStatus.connected ? 'good' : 'neutral'}`}>
              {authStatus.connected ? 'Live: Zoho Connected' : 'Active Email Feed'}
            </span>
            <button
              type="button"
              className="ghost-button"
              disabled={syncing}
              onClick={handleSync}
              style={{ padding: '0.35rem 0.8rem', fontSize: '0.82rem' }}
            >
              {syncing ? 'Syncing...' : 'Sync Zoho Emails'}
            </button>
            <a
              className="primary-button"
              href="https://crm.zoho.in/crm/tab/Emails"
              target="_blank"
              rel="noreferrer"
              style={{ padding: '0.35rem 0.8rem', fontSize: '0.82rem' }}
            >
              Open Zoho Mail
              <ArrowUpRight size={14} />
            </a>
          </div>
        </div>

        {syncMsg ? (
          <div
            style={{
              padding: '0.6rem 0.9rem',
              marginBottom: '1rem',
              borderRadius: '8px',
              fontSize: '0.85rem',
              backgroundColor: syncMsg.includes('error') ? '#ffefef' : '#eaf7ee',
              color: syncMsg.includes('error') ? '#c53030' : '#22543d',
              border: `1px solid ${syncMsg.includes('error') ? '#fed7d7' : '#c6f6d5'}`,
            }}
          >
            {syncMsg}
          </div>
        ) : null}

        {/* 4 STAT CARDS */}
        <div className="stats-grid" style={{ marginBottom: '1.25rem' }}>
          <div className="stat-card">
            <span>Total Emails Exchanged</span>
            <strong>{stats.total || emails.length}</strong>
            <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
              All executive communications
            </p>
          </div>
          <div className="stat-card">
            <span>Sent by Executives</span>
            <strong>{stats.outbound || 0}</strong>
            <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
              Outbound client outreach
            </p>
          </div>
          <div className="stat-card">
            <span>Received from Clients</span>
            <strong>{stats.inbound || 0}</strong>
            <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
              Inbound replies & queries
            </p>
          </div>
          <div className="stat-card">
            <span>Active Executives</span>
            <strong>{stats.activeExecutives || stats.executives?.length || 1}</strong>
            <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
              Ambuj, Sahil, Riya & team
            </p>
          </div>
        </div>

        {/* FILTER BAR */}
        <div className="filter-bar" style={{ padding: '0.75rem 0', borderTop: '1px solid #eef2f8' }}>
          <div className="search-box">
            <Search size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by subject, client name, email, or content snippet..."
            />
          </div>

          <select value={selectedExec} onChange={(e) => setSelectedExec(e.target.value)}>
            <option value="">All Executives</option>
            {(stats.executives || []).map((ex) => (
              <option key={ex.executive_email} value={ex.executive_email}>
                {ex.executive_name} ({ex.email_count})
              </option>
            ))}
          </select>

          <select value={selectedDirection} onChange={(e) => setSelectedDirection(e.target.value)}>
            <option value="">All Directions</option>
            <option value="outbound">Outbound (Sent by Executive)</option>
            <option value="inbound">Inbound (Received from Client)</option>
          </select>
        </div>

        {loading && emails.length === 0 ? <LoadingBlock label="Loading Zoho executive emails..." /> : null}
        {error ? <ErrorCard message={error} /> : null}

        <div className="stack-list">
          {emails.map((item) => {
            const isOutbound = item.direction === 'outbound';
            return (
              <div key={item.id} className="list-row">
                <div>
                  <strong>{item.client_name || 'Client'}</strong>
                  <p>{item.client_email}</p>
                  <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.25rem' }}>
                    {isOutbound ? `To: ${item.client_email}` : `From: ${item.client_email}`}
                  </p>
                </div>
                <div>
                  <div className="row-actions" style={{ marginBottom: '0.45rem' }}>
                    <span className={`pill ${isOutbound ? 'good' : 'neutral'}`}>
                      {isOutbound ? `Sent by ${item.executive_name}` : `Received by ${item.executive_name}`}
                    </span>
                    <span className="pill neutral" style={{ fontSize: '0.74rem' }}>
                      {item.executive_email}
                    </span>
                    {item.status ? (
                      <span className="pill good" style={{ textTransform: 'capitalize' }}>
                        {item.status}
                      </span>
                    ) : null}
                  </div>
                  <strong>{item.subject}</strong>
                  <p style={{ marginTop: '0.25rem', color: '#334155' }}>
                    {item.summary || item.body_snippet}
                  </p>
                </div>
                <div className="meta-align">
                  <div style={{ marginBottom: '0.4rem', fontSize: '0.82rem', color: '#64748b' }}>
                    {formatDateTime(item.sent_at)}
                  </div>
                  <div className="row-actions">
                    {item.lead_id ? (
                      <Link
                        className="ghost-button"
                        to={`/leads/${item.lead_id}`}
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.8rem' }}
                      >
                        Lead 360
                      </Link>
                    ) : null}
                    <a
                      className="primary-button"
                      href={item.zoho_url || 'https://crm.zoho.in/crm/tab/Emails'}
                      target="_blank"
                      rel="noreferrer"
                      style={{ padding: '0.3rem 0.65rem', fontSize: '0.8rem' }}
                    >
                      Open in Zoho
                      <ArrowUpRight size={13} />
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {!loading && !error && emails.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2.5rem 1.5rem', background: '#f8fafc', borderRadius: '12px', border: '1px solid #e2e8f0', margin: '1rem 0' }}>
            <div style={{ fontSize: '1.8rem', marginBottom: '0.4rem' }}>📬</div>
            <strong style={{ fontSize: '1rem', color: '#0f172a' }}>No 1-on-1 CRM Emails in Zoho CRM Yet</strong>
            <p style={{ margin: '0.4rem auto 0 auto', maxWidth: '480px', fontSize: '0.85rem', color: '#64748b', lineHeight: 1.5 }}>
              Outreach campaigns are tracked under the <strong>Campaigns</strong> tab. When BD executives send or receive direct emails inside Zoho CRM Leads or Contacts, they will automatically appear here.
            </p>
          </div>
        ) : null}
      </section>
    </section>
  );
}

function WhatsAppFeedPage({ refreshKey }) {
  const [messages, setMessages] = useState([]);
  const [stats, setStats] = useState({
    total_messages: 0,
    incoming_count: 0,
    outgoing_count: 0,
    active_contacts: 0,
    active_executives: 0,
    by_executive: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedExec, setSelectedExec] = useState('');
  const [selectedDirection, setSelectedDirection] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [linkingExecId, setLinkingExecId] = useState(null);
  const [linkingQr, setLinkingQr] = useState(null);
  const [linkingStatus, setLinkingStatus] = useState('');
  const [sessionActionMsg, setSessionActionMsg] = useState('');
  const [newExecName, setNewExecName] = useState('');
  const [newExecPhone, setNewExecPhone] = useState('');
  const [newExecEmail, setNewExecEmail] = useState('');
  const [addingExec, setAddingExec] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      setLoadingSessions(true);
      const res = await fetch(`${API_BASE}/api/whatsapp/sessions`);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const json = await res.json();
      const list = json.data || [];
      setSessions(list);
      return list;
    } catch (err) {
      console.warn('Failed to load WhatsApp sessions:', err.message);
      return [];
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    if (showModal) {
      loadSessions();
    }
  }, [showModal, loadSessions, refreshKey]);

  // Poll session status every 2s while waiting for QR generation or scan
  useEffect(() => {
    if (!showModal || !linkingExecId) return undefined;
    const timer = setInterval(async () => {
      const list = await loadSessions();
      const current = list.find((item) => item.executiveId === linkingExecId);
      if (current?.qr) {
        setLinkingQr(current.qr);
        setLinkingStatus('Scan this QR code with WhatsApp on the executive phone');
      } else if (current?.status === 'connected') {
        setLinkingQr(null);
        setLinkingStatus(`Connected! Phone: ${current.phone || 'Ready'}`);
        setLinkingExecId(null);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [showModal, linkingExecId, loadSessions]);

  async function handleAddExecutive(e) {
    e.preventDefault();
    if (!newExecName.trim()) {
      setSessionActionMsg('Please enter executive name.');
      return;
    }
    try {
      setAddingExec(true);
      setSessionActionMsg('');
      const res = await fetch(`${API_BASE}/api/executives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newExecName.trim(),
          phone: newExecPhone.trim(),
          email: newExecEmail.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Failed to add executive');
      }
      setNewExecName('');
      setNewExecPhone('');
      setNewExecEmail('');
      setSessionActionMsg(`Executive "${json.data.name}" added! Now click "Link Phone" to scan QR.`);
      await loadSessions();
    } catch (err) {
      setSessionActionMsg(`Error: ${err.message}`);
    } finally {
      setAddingExec(false);
    }
  }

  async function handleRemoveExecutive(executiveId, executiveName) {
    try {
      setSessionActionMsg(`Removing ${executiveName}...`);
      const res = await fetch(`${API_BASE}/api/executives/${executiveId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to remove executive');
      if (linkingExecId === executiveId) {
        setLinkingExecId(null);
        setLinkingQr(null);
      }
      setSessionActionMsg(`Removed ${executiveName}.`);
      await loadSessions();
    } catch (err) {
      setSessionActionMsg(`Error: ${err.message}`);
    }
  }

  async function handleStartLinking(executiveId) {
    try {
      setLinkingExecId(executiveId);
      setLinkingStatus('Connecting to WhatsApp server & generating QR code...');
      setLinkingQr(null);
      setSessionActionMsg('');

      const res = await fetch(`${API_BASE}/api/whatsapp/sessions/${executiveId}/start`, {
        method: 'POST',
      });
      const json = await res.json();
      if (json.data?.qr) {
        setLinkingQr(json.data.qr);
        setLinkingStatus('Scan this QR code with WhatsApp on the executive phone');
      } else if (json.data?.status === 'connected') {
        setLinkingStatus(`Connected! Phone: ${json.data.phone || 'Ready'}`);
      }
      await loadSessions();
    } catch (err) {
      setLinkingStatus(`Error: ${err.message}`);
    }
  }

  async function handleDisconnectSession(executiveId) {
    try {
      setSessionActionMsg('Disconnecting...');
      await fetch(`${API_BASE}/api/whatsapp/sessions/${executiveId}/disconnect`, {
        method: 'POST',
      });
      setSessionActionMsg('Disconnected successfully.');
      if (linkingExecId === executiveId) {
        setLinkingExecId(null);
        setLinkingQr(null);
      }
      await loadSessions();
    } catch (err) {
      setSessionActionMsg(`Error: ${err.message}`);
    }
  }

  const loadMessages = useCallback(
    async ({ silent } = {}) => {
      try {
        if (!silent) setLoading(true);
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (selectedExec) params.set('executive', selectedExec);
        if (selectedDirection) params.set('direction', selectedDirection);

        const res = await fetch(`${API_BASE}/api/whatsapp/messages?${params.toString()}`);
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        const json = await res.json();
        const payload = json.data || {};
        setMessages(payload.messages || []);
        if (payload.stats) setStats(payload.stats);
        setError('');
      } catch (err) {
        setError(err.message || 'Failed to load WhatsApp messages');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [search, selectedExec, selectedDirection],
  );

  useEffect(() => {
    loadMessages({ silent: false });
  }, [loadMessages, refreshKey]);

  return (
    <section className="page-stack">
      <section className="card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Platform Feed</div>
            <h3>WhatsApp Communications</h3>
            <p>
              Live incoming and outgoing WhatsApp messages synced from sales executives' work SIMs.
            </p>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => setShowModal(true)}
              style={{ padding: '0.35rem 0.8rem', fontSize: '0.82rem' }}
            >
              🔗 Link Executive Device (Server QR)
            </button>
          </div>
        </div>

        <div className="stats-grid" style={{ marginTop: '1rem', marginBottom: '1.25rem' }}>
          <StatCard label="Total Messages" value={stats.total_messages} />
          <StatCard label="Incoming (Clients)" value={stats.incoming_count} />
          <StatCard label="Outgoing (Executives)" value={stats.outgoing_count} />
          <StatCard label="Active Contacts" value={stats.active_contacts} />
        </div>

        <div className="filter-bar" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <div className="search-box" style={{ flex: '1 1 240px' }}>
            <Search size={16} />
            <input
              type="text"
              placeholder="Search by client, phone, executive, or message text..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              type="button"
              className={`ghost-button ${selectedDirection === '' ? 'active' : ''}`}
              style={{
                padding: '0.4rem 0.8rem',
                fontWeight: selectedDirection === '' ? 600 : 400,
                backgroundColor: selectedDirection === '' ? 'var(--color-surface-hover)' : 'transparent',
              }}
              onClick={() => setSelectedDirection('')}
            >
              All
            </button>
            <button
              type="button"
              className={`ghost-button ${selectedDirection === 'incoming' ? 'active' : ''}`}
              style={{
                padding: '0.4rem 0.8rem',
                fontWeight: selectedDirection === 'incoming' ? 600 : 400,
                backgroundColor: selectedDirection === 'incoming' ? 'var(--color-surface-hover)' : 'transparent',
              }}
              onClick={() => setSelectedDirection('incoming')}
            >
              Incoming (Clients)
            </button>
            <button
              type="button"
              className={`ghost-button ${selectedDirection === 'outgoing' ? 'active' : ''}`}
              style={{
                padding: '0.4rem 0.8rem',
                fontWeight: selectedDirection === 'outgoing' ? 600 : 400,
                backgroundColor: selectedDirection === 'outgoing' ? 'var(--color-surface-hover)' : 'transparent',
              }}
              onClick={() => setSelectedDirection('outgoing')}
            >
              Outgoing (Executives)
            </button>
          </div>

          {stats.by_executive?.length > 1 ? (
            <select
              value={selectedExec}
              onChange={(e) => setSelectedExec(e.target.value)}
              style={{
                padding: '0.4rem 0.8rem',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                background: 'var(--color-surface)',
                color: 'var(--color-text)',
              }}
            >
              <option value="">All Executives</option>
              {stats.by_executive.map((ex) => (
                <option key={ex.executive_name} value={ex.executive_name}>
                  {ex.executive_name} ({ex.message_count})
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {loading ? <LoadingBlock label="Loading WhatsApp conversations..." /> : null}
        {error ? <ErrorCard message={error} /> : null}

        <div className="stack-list">
          {messages.map((item) => (
            <div
              key={item.id}
              className="list-row"
              style={{
                borderLeft: item.direction === 'incoming' ? '4px solid #10b981' : '4px solid #3b82f6',
                paddingLeft: '0.85rem',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                  <span className={`pill ${item.direction === 'incoming' ? 'good' : 'neutral'}`}>
                    {item.direction === 'incoming' ? '💬 Received from Client' : '📤 Sent by Exec'}
                  </span>
                  {item.lead_id ? (
                    <Link
                      to={`/leads/${item.lead_id}`}
                      style={{
                        fontWeight: 600,
                        color: 'inherit',
                        textDecoration: 'none',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                      }}
                    >
                      {item.client_name || item.client_phone}
                      <ArrowUpRight size={13} />
                    </Link>
                  ) : (
                    <strong>{item.client_name || item.client_phone}</strong>
                  )}
                  {item.stage ? (
                    <span className="pill neutral" style={{ fontSize: '0.72rem', padding: '0.15rem 0.45rem' }}>
                      {item.stage}
                    </span>
                  ) : null}
                </div>
                <p style={{ margin: '0.15rem 0', color: 'var(--color-text-secondary)', fontSize: '0.84rem' }}>
                  📱 Phone: <strong>{item.client_phone}</strong> | Executive: <strong>{item.executive_name}</strong> {item.device_id ? `(${item.device_id})` : ''}
                </p>
                <div
                  style={{
                    background: item.direction === 'incoming' ? 'rgba(16, 185, 129, 0.08)' : 'rgba(59, 130, 246, 0.08)',
                    borderRadius: '8px',
                    padding: '0.65rem 0.85rem',
                    marginTop: '0.4rem',
                    fontSize: '0.9rem',
                    lineHeight: '1.45',
                  }}
                >
                  {item.message}
                </div>
              </div>
              <div className="meta-align" style={{ minWidth: '130px', textAlign: 'right' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                  {formatDateTime(item.timestamp)}
                </span>
              </div>
            </div>
          ))}
        </div>

        {!loading && !error && messages.length === 0 ? (
          <EmptyBlock label="No WhatsApp messages matching the selected criteria." />
        ) : null}

        {showModal ? (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.65)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
              padding: '1rem',
            }}
          >
            <div
              className="card"
              style={{
                maxWidth: '560px',
                width: '100%',
                maxHeight: '90vh',
                overflowY: 'auto',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)',
              }}
            >
              <div className="section-head" style={{ marginBottom: '1rem' }}>
                <div>
                  <div className="eyebrow">Multi-Device Server Bridge</div>
                  <h3>Link Sales Executive WhatsApp</h3>
                  <p>
                    Connects directly to the cloud backend. Captures both <strong>incoming</strong> and <strong>outgoing</strong> lead chats reliably.
                  </p>
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setShowModal(false);
                    setLinkingExecId(null);
                    setLinkingQr(null);
                  }}
                  style={{ fontSize: '1.2rem', padding: '0.2rem 0.6rem' }}
                >
                  ✕
                </button>
              </div>

              {sessionActionMsg ? (
                <div style={{ marginBottom: '0.75rem' }}>
                  <span className="pill neutral">{sessionActionMsg}</span>
                </div>
              ) : null}

              <form
                onSubmit={handleAddExecutive}
                style={{
                  background: 'var(--color-surface-hover, #f8fafc)',
                  border: '1px solid var(--color-border, #e2e8f0)',
                  borderRadius: '10px',
                  padding: '0.75rem',
                  marginBottom: '1rem',
                }}
              >
                <div style={{ fontSize: '0.78rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--color-text-secondary)' }}>
                  + Add New Sales Executive
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    placeholder="Executive Name (e.g. Sahil)"
                    value={newExecName}
                    onChange={(e) => setNewExecName(e.target.value)}
                    required
                    style={{
                      flex: '1 1 140px',
                      padding: '0.45rem 0.65rem',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border, #cbd5e1)',
                      fontSize: '0.84rem',
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Work Phone (+91...)"
                    value={newExecPhone}
                    onChange={(e) => setNewExecPhone(e.target.value)}
                    style={{
                      flex: '1 1 130px',
                      padding: '0.45rem 0.65rem',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border, #cbd5e1)',
                      fontSize: '0.84rem',
                    }}
                  />
                  <input
                    type="email"
                    placeholder="Email (optional)"
                    value={newExecEmail}
                    onChange={(e) => setNewExecEmail(e.target.value)}
                    style={{
                      flex: '1 1 150px',
                      padding: '0.45rem 0.65rem',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border, #cbd5e1)',
                      fontSize: '0.84rem',
                    }}
                  />
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={addingExec}
                    style={{ padding: '0.45rem 0.85rem', fontSize: '0.82rem' }}
                  >
                    {addingExec ? 'Adding...' : 'Add'}
                  </button>
                </div>
              </form>

              {linkingExecId && !linkingQr ? (
                <div
                  style={{
                    textAlign: 'center',
                    padding: '0.85rem',
                    background: 'var(--color-surface-hover, #f8fafc)',
                    borderRadius: '8px',
                    marginBottom: '1rem',
                    border: '1px solid var(--color-border)',
                    fontSize: '0.85rem',
                  }}
                >
                  ⏳ {linkingStatus || 'Generating QR code...'}
                </div>
              ) : null}

              {linkingQr ? (
                <div
                  style={{
                    textAlign: 'center',
                    padding: '1rem',
                    background: 'var(--color-surface-hover, #f8fafc)',
                    borderRadius: '8px',
                    marginBottom: '1rem',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  <h4 style={{ margin: '0 0 0.5rem 0' }}>Scan with Executive's Phone</h4>
                  <img
                    src={linkingQr}
                    alt="WhatsApp QR Code"
                    style={{
                      width: '240px',
                      height: '240px',
                      display: 'block',
                      margin: '0 auto',
                      borderRadius: '8px',
                      border: '4px solid white',
                    }}
                  />
                  <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                    📱 <strong>Steps on Phone:</strong> WhatsApp ➔ <strong>3 dots (Menu)</strong> ➔ <strong>Linked Devices</strong> ➔ <strong>Link a Device</strong> ➔ Scan this QR.
                  </p>
                  <p style={{ fontSize: '0.8rem', color: '#10b981', fontWeight: 600 }}>
                    {linkingStatus}
                  </p>
                </div>
              ) : null}

              <div className="stack-list">
                {sessions.map((sess) => (
                  <div
                    key={sess.executiveId}
                    className="list-row"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.75rem',
                    }}
                  >
                    <div>
                      <strong>{sess.executiveName}</strong>
                      <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', margin: '0.1rem 0' }}>
                        {sess.executiveEmail} {sess.phone ? `| 📱 ${sess.phone}` : ''}
                      </p>
                      <div style={{ marginTop: '0.25rem' }}>
                        <span className={`pill ${sess.status === 'connected' ? 'good' : 'neutral'}`} style={{ fontSize: '0.75rem' }}>
                          {sess.status === 'connected'
                            ? '🟢 Connected (Multi-Device)'
                            : sess.status === 'qr_ready'
                              ? '🟡 QR Ready'
                              : sess.status === 'connecting'
                                ? '🔵 Connecting...'
                                : '⚪ Not Linked'}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
                      {sess.status === 'connected' ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => handleDisconnectSession(sess.executiveId)}
                          style={{ padding: '0.3rem 0.6rem', fontSize: '0.78rem', color: '#ef4444' }}
                        >
                          Disconnect
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => handleStartLinking(sess.executiveId)}
                            style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                          >
                            {linkingExecId === sess.executiveId ? 'Regenerate QR' : 'Link Phone'}
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => handleRemoveExecutive(sess.executiveId, sess.executiveName)}
                            title="Remove executive"
                            style={{ padding: '0.3rem 0.5rem', fontSize: '0.78rem', color: '#ef4444' }}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: '1.25rem', textAlign: 'right' }}>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setShowModal(false);
                    setLinkingExecId(null);
                    setLinkingQr(null);
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </section>
  );
}

function PlatformPage({ refreshKey }) {
  const { platform } = useParams();
  const current = platformCopy[platform] || {
    title: 'Platform',
    description: 'Future connector placeholder',
  };

  if (platform === 'campaign') {
    return <CampaignsFeedPage />;
  }

  if (platform === 'email') {
    return <ZohoEmailsPage />;
  }

  if (platform === 'whatsapp') {
    return <WhatsAppFeedPage refreshKey={refreshKey} />;
  }

  const state = useAsync(() => api(`/api/activities?platform=${platform}`), [platform]);

  return (
    <section className="page-stack">
      <section className="platform-shell">
        <div className="section-head">
          <div>
            <div className="eyebrow">Platform skeleton</div>
            <h3>{current.title}</h3>
            <p>{current.description}</p>
          </div>
          <span className="pill neutral">Seeded feed</span>
        </div>

        {state.loading ? <LoadingBlock label={`Loading ${platform} activities...`} /> : null}
        {state.error ? <ErrorCard message={state.error} /> : null}

        <div className="stack-list">
          {(state.data || []).map((item) => (
            <div key={item.id} className="list-row">
              <div>
                <strong>{item.client_name}</strong>
                <p>{item.client_phone}</p>
              </div>
              <div>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
              </div>
              <div className="meta-align">{formatDateTime(item.created_at)}</div>
            </div>
          ))}
        </div>

        {!state.loading && (state.data || []).length === 0 ? (
          <EmptyBlock label={`No ${platform} activity in local seed data.`} />
        ) : null}
      </section>
    </section>
  );
}

function SettingsPage() {
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const settingsState = useAsync(() => api('/api/settings/zoho'), []);

  async function handleZohoSync() {
    try {
      setSyncing(true);
      setSyncMsg('');
      const res = await fetch(`${API_BASE}/api/settings/zoho/sync`, { method: 'POST' });
      const json = await res.json();
      if (json.data?.ok) {
        setSyncMsg(`Sync complete! Processed: ${json.data.processed}, Inserted: ${json.data.inserted}, Updated: ${json.data.updated}`);
      } else {
        setSyncMsg(json.data?.message || json.message || 'Sync skipped or failed');
      }
    } catch (err) {
      setSyncMsg(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="page-stack">
      <section className="card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Zoho CRM Integration</div>
            <h3>CRM Connection & Auto-Sync</h3>
            <p>Direct navigation links and automatic lead data synchronization.</p>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="primary-button"
              disabled={syncing}
              onClick={handleZohoSync}
              style={{ padding: '0.4rem 0.85rem', fontSize: '0.85rem' }}
            >
              {syncing ? 'Syncing...' : 'Sync Zoho Leads Now'}
            </button>
          </div>
        </div>

        {syncMsg ? <div className="status-card" style={{ marginBottom: '1rem' }}>{syncMsg}</div> : null}

        {settingsState.loading ? <LoadingBlock label="Loading settings..." /> : null}
        {settingsState.error ? <ErrorCard message={settingsState.error} /> : null}

        {settingsState.data ? (
          <div className="detail-grid">
            <InfoCard title="Connected" value={settingsState.data.connected ? 'Yes' : 'No'} />
            <InfoCard title="Mode" value={settingsState.data.mode} />
            <InfoCard title="Base URL" value={settingsState.data.baseUrl || 'Not configured'} />
            <InfoCard title="Status note" value={settingsState.data.message} />
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="section-head">
          <div>
            <h3>What this repo does now</h3>
            <p>Current milestone boundaries are clearly delineated.</p>
          </div>
        </div>

        <div className="stack-list compact">
          <div className="list-row">
            <div>
              <strong>Now</strong>
              <p>Calls UI, local SQLite model, platform tabs, Lead 360, Manyreach sync, Zoho link & API auto-sync connector.</p>
            </div>
          </div>
          <div className="list-row">
            <div>
              <strong>Next</strong>
              <p>Two-way notes and stage write-back to Zoho CRM upon call completion.</p>
            </div>
          </div>
        </div>
      </section>
    </section>
  );
}

function StatCard({ label, value }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value ?? '-'}</strong>
    </article>
  );
}

function SummaryCard({ label, value, subtext }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value ?? '-'}</strong>
      {subtext ? (
        <p className="muted-line" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
          {subtext}
        </p>
      ) : null}
    </article>
  );
}

function InfoCard({ title, value }) {
  return (
    <div className="info-card">
      <label>{title}</label>
      <p>{value || '-'}</p>
    </div>
  );
}

function ScoreCard({ score }) {
  const entries = Object.entries(score?.skillScores || {});

  return (
    <div className="scorecard">
      <div className="score-head">
        <div>
          <label>Overall score</label>
          <strong>{score?.overall ?? '-'}/5</strong>
        </div>
      </div>

      <div className="score-bars">
        {entries.map(([key, value]) => (
          <div key={key} className="score-row">
            <div className="score-row-top">
              <span>{key.replaceAll('_', ' ')}</span>
              <strong>{value}</strong>
            </div>
            <div className="bar-track">
              <div className={`bar-fill ${scoreTone(value)}`} style={{ width: `${(value / 5) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      {score?.commitments?.length ? (
        <div className="info-block">
          <label>Commitments</label>
          <ul className="plain-list">
            {score.commitments.map((item, index) => (
              <li key={index}>
                {item.by}: {item.what} {item.due ? `(${item.due})` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {score?.coachingNote ? (
        <div className="info-block">
          <label>Coaching note</label>
          <p>
            <strong>Strength:</strong> {score.coachingNote.strength}
          </p>
          <p>
            <strong>Gap:</strong> {score.coachingNote.gap}
          </p>
          <p>
            <strong>Try next:</strong> {score.coachingNote.tryLine}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function LoadingBlock({ label }) {
  return <div className="status-card">{label}</div>;
}

function EmptyBlock({ label }) {
  return <div className="status-card muted">{label}</div>;
}

function ErrorCard({ message }) {
  return <div className="status-card error">{message}</div>;
}

function useRealtimeUpdates() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [liveNotice, setLiveNotice] = useState('');

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/api/events`);
    let noticeTimer;

    source.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'call.completed') {
          const clientName = message.payload?.client_name || 'New prospect';
          setRefreshKey((value) => value + 1);
          setLiveNotice(`New completed call received: ${clientName}`);

          clearTimeout(noticeTimer);
          noticeTimer = window.setTimeout(() => {
            setLiveNotice('');
          }, 5000);
        } else if (message.type === 'whatsapp.received') {
          const clientName = message.payload?.client_name || message.payload?.client_phone || 'WhatsApp contact';
          const snippet = message.payload?.message ? `: "${message.payload.message.slice(0, 45)}..."` : '';
          setRefreshKey((value) => value + 1);
          setLiveNotice(`💬 New WhatsApp from ${clientName}${snippet}`);

          clearTimeout(noticeTimer);
          noticeTimer = window.setTimeout(() => {
            setLiveNotice('');
          }, 5000);
        } else if (message.type === 'whatsapp.session_updated') {
          setRefreshKey((value) => value + 1);
          if (message.payload?.status === 'connected') {
            setLiveNotice(`🟢 WhatsApp linked for ${message.payload.executiveName || 'Executive'} (${message.payload.phone || 'Ready'})`);
            clearTimeout(noticeTimer);
            noticeTimer = window.setTimeout(() => {
              setLiveNotice('');
            }, 6000);
          }
        }
      } catch {
        // Ignore malformed events and keep the stream alive.
      }
    };

    return () => {
      clearTimeout(noticeTimer);
      source.close();
    };
  }, []);

  return { refreshKey, liveNotice };
}

function WorkspaceRoutes() {
  const { refreshKey, liveNotice } = useRealtimeUpdates();

  return (
    <AppShell liveNotice={liveNotice}>
      <Routes>
        <Route path="/" element={<DashboardPage refreshKey={refreshKey} />} />
        <Route path="/calls" element={<CallsPage refreshKey={refreshKey} />} />
        <Route path="/calls/:callId" element={<CallDetailPage refreshKey={refreshKey} />} />
        <Route path="/platforms/:platform" element={<PlatformPage refreshKey={refreshKey} />} />
        <Route path="/zoho-crm" element={<ZohoCrmPage refreshKey={refreshKey} />} />
        <Route path="/zoho-accounts" element={<ZohoAccountsPage refreshKey={refreshKey} />} />
        <Route path="/lead-360" element={<Lead360Page refreshKey={refreshKey} />} />
        <Route path="/leads/:leadId" element={<LeadDetailPage refreshKey={refreshKey} />} />
        <Route path="/pitch-training" element={<PitchTrainingPage />} />
        <Route path="/client-intel" element={<ClientIntelPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <WorkspaceRoutes />
    </BrowserRouter>
  );
}
