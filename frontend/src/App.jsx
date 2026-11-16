import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  LayoutDashboard,
  Mail,
  Megaphone,
  MessageCircleMore,
  Phone,
  Search,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
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
  { to: '/platforms/whatsapp', label: 'WhatsApp', icon: MessageCircleMore },
  { to: '/platforms/email', label: 'Email', icon: Mail },
  { to: '/platforms/campaign', label: 'Campaigns', icon: Megaphone },
  { to: '/lead-360', label: 'Lead 360', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const platformCopy = {
  whatsapp: {
    title: 'WhatsApp',
    description: 'Call complete hote hi non-scoring follow-up yahan track ho sakta hai.',
  },
  email: {
    title: 'Email',
    description: 'Drafts, promised documents aur follow-up email readiness ko yahan surface kiya gaya hai.',
  },
  campaign: {
    title: 'Campaigns',
    description: 'Lead engagement aur campaign touchpoints ko calls ke saath align karne ke liye.',
  },
};

async function api(path) {
  const response = await fetch(`${API_BASE}${path}`);
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
  if (pathname.startsWith('/platforms/')) return 'Platform Feed';
  if (pathname.startsWith('/lead-360')) return 'Lead 360';
  if (pathname.startsWith('/leads/')) return 'Lead Detail';
  if (pathname.startsWith('/settings')) return 'Settings';
  return 'Dashboard';
}

function AppShell({ children }) {
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
            <p>Yeh repo local SQLite aur seeded data par chal raha hai. Live systems untouched hain.</p>
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
        {children}
      </main>
    </div>
  );
}

function DashboardPage() {
  const dashboard = useAsync(() => api('/api/dashboard'), []);
  const activities = useAsync(() => api('/api/activities'), []);

  const feed = useMemo(() => activities.data || [], [activities.data]);
  const stats = dashboard.data?.stats;
  const recent = dashboard.data?.recent || [];

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <div>
          <div className="eyebrow">7-day foundation</div>
          <h3>Calls-first working cockpit</h3>
          <p>
            Yeh phase calls, promises, next actions aur platform follow-up ko ek jagah visible karta
            hai. Zoho ko abhi destination boundary rakha gaya hai, hard dependency nahi.
          </p>
        </div>
        <div className="hero-badges">
          <span className="pill neutral">Local DB</span>
          <span className="pill neutral">Seeded November calls</span>
          <span className="pill neutral">Zoho navigation ready</span>
        </div>
      </div>

      {dashboard.error ? <ErrorCard message={dashboard.error} /> : null}

      <div className="stats-grid">
        <StatCard label="Total Calls" value={stats?.total_calls} />
        <StatCard label="November Calls" value={stats?.november_calls} />
        <StatCard label="Hot Leads" value={stats?.hot_leads} />
        <StatCard label="Promises Captured" value={stats?.promises} />
      </div>

      <div className="two-column">
        <section className="card">
          <div className="section-head">
            <div>
              <h3>Recent Calls</h3>
              <p>Who called whom, kya baat hui, aur next step kya hai.</p>
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
              <p>Scoring ke bina bhi jo follow-up actions chahiye woh yahan visible hain.</p>
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
    </section>
  );
}

function CallsPage() {
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const callsState = useAsync(
    () => api(`/api/calls?search=${encodeURIComponent(search)}&stage=${encodeURIComponent(stage)}`),
    [search, stage],
  );

  const calls = callsState.data || [];
  const stages = Array.from(new Set(calls.map((item) => item.stage).filter(Boolean)));

  return (
    <section className="page-stack">
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
              <label>What happened</label>
              <p>{call.summary}</p>
            </div>
            <div className="info-block">
              <label>Promise</label>
              <p>{call.promise}</p>
            </div>
            <div className="info-block">
              <label>Next action</label>
              <p>{call.next_action}</p>
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

function CallDetailPage() {
  const { callId } = useParams();
  const navigate = useNavigate();
  const callState = useAsync(() => api(`/api/calls/${callId}`), [callId]);
  const settingsState = useAsync(() => api('/api/settings/zoho'), []);
  const leadId = callState.data?.lead_id;
  const leadState = useAsync(
    () => (leadId ? api(`/api/leads/${leadId}`) : Promise.resolve(null)),
    [leadId],
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
              <InfoCard title="Promise" value={call.promise} />
              <InfoCard title="Next action" value={call.next_action} />
            </div>
          </section>

          <div className="two-column">
            <section className="card">
              <div className="section-head">
                <div>
                  <h3>Business Outcome</h3>
                  <p>Call ka summary aur commitment capture.</p>
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
                  <p>Training async rahegi, but score visibility yahan milegi.</p>
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
                  <p>Lead 360 view ke liye direct bridge.</p>
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
                    <p>{lead.next_action}</p>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="card">
              <div className="section-head">
                <div>
                  <h3>Related Platform Activities</h3>
                  <p>Call ke baad email / WhatsApp / campaign trace.</p>
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

function Lead360Page() {
  const leadsState = useAsync(() => api('/api/leads'), []);
  const leads = leadsState.data || [];

  return (
    <section className="page-stack">
      <section className="card">
        <div className="section-head">
          <div>
            <h3>Merged Lead Story</h3>
            <p>Calls alag tab me rahenge, par lead timeline yahan merge hogi.</p>
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

function LeadDetailPage() {
  const { leadId } = useParams();
  const leadState = useAsync(() => api(`/api/leads/${leadId}`), [leadId]);
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
              <InfoCard title="Next action" value={lead.next_action} />
            </div>
          </section>

          <div className="two-column">
            <section className="card">
              <div className="section-head">
                <div>
                  <h3>Calls</h3>
                  <p>Lead ke saath huye recent calls.</p>
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

function PlatformPage() {
  const { platform } = useParams();
  const current = platformCopy[platform] || {
    title: 'Platform',
    description: 'Future connector placeholder',
  };
  const state = useAsync(() => api(`/api/activities?platform=${platform}`), [platform]);

  return (
    <section className="page-stack">
      <section className="card">
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
  const settingsState = useAsync(() => api('/api/settings/zoho'), []);

  return (
    <section className="page-stack">
      <section className="card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Zoho boundary</div>
            <h3>Navigation first, sync later</h3>
            <p>Phase 1 me UI ko Zoho auth repair se block nahi kiya gaya hai.</p>
          </div>
        </div>

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
            <p>Current milestone boundaries clearly separated hain.</p>
          </div>
        </div>

        <div className="stack-list compact">
          <div className="list-row">
            <div>
              <strong>Now</strong>
              <p>Calls UI, local data model, platform tabs, Lead 360, Zoho open-link hook.</p>
            </div>
          </div>
          <div className="list-row">
            <div>
              <strong>Next</strong>
              <p>Zoho auth repair ke baad note sync, task sync, aur stage sync backend bridge se.</p>
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

function WorkspaceRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/calls" element={<CallsPage />} />
        <Route path="/calls/:callId" element={<CallDetailPage />} />
        <Route path="/platforms/:platform" element={<PlatformPage />} />
        <Route path="/lead-360" element={<Lead360Page />} />
        <Route path="/leads/:leadId" element={<LeadDetailPage />} />
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
