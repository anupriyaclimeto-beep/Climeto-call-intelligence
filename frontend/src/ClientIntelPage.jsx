import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ClientIntelCard from './ClientIntelCard.jsx';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4200';

const panelStyle = {
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: '16px',
  padding: '1.35rem 1.5rem',
  boxShadow: '0 2px 6px rgba(15, 23, 42, 0.04)',
};

export default function ClientIntelPage() {
  const [intelList, setIntelList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState('');

  // Filters
  const [search, setSearch] = useState('');
  const [tempFilter, setTempFilter] = useState('');

  // Real-data Pre-pitch company lookup
  const [lookupQuery, setLookupQuery] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [showCandidatePicker, setShowCandidatePicker] = useState(false);
  const [searchingCandidates, setSearchingCandidates] = useState(false);
  const [loadingDossier, setLoadingDossier] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [lookupResult, setLookupResult] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [recentSearches, setRecentSearches] = useState([]);
  const [syncingZohoId, setSyncingZohoId] = useState(null);
  const [syncingCalls, setSyncingCalls] = useState(false);

  const handleSyncCalls = async () => {
    setSyncingCalls(true);
    setLookupError('');
    try {
      const res = await fetch(`${API_BASE}/api/training/intel/sync-calls`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setBanner(`Successfully processed ${json.count || 0} calls with verified transcript facts.`);
        loadIntel({ silent: false });
      } else {
        setError(json.message || 'Failed to sync calls');
      }
    } catch (err) {
      setError(err.message || 'Network error syncing calls');
    } finally {
      setSyncingCalls(false);
    }
  };

  const loadIntel = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      const res = await fetch(`${API_BASE}/api/training/intel`);
      const json = await res.json();
      if (json.success) {
        setIntelList(json.data || []);
        setError('');
      } else {
        setError(json.message || 'Failed to load Client Intel');
      }
    } catch (err) {
      setError(err.message || 'Network error fetching Client Intel');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadRecentSearches = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/training/intel/recent-searches`);
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setRecentSearches(json.data);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadIntel();
    loadRecentSearches();

    let es = null;
    try {
      es = new EventSource(`${API_BASE}/api/events`);
      es.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (
            payload.type === 'client.intel_extracted' ||
            payload.type === 'client.intel_updated' ||
            payload.type === 'call.completed'
          ) {
            loadIntel({ silent: true });
          }
        } catch {}
      };
    } catch {}

    return () => {
      if (es) es.close();
    };
  }, [loadIntel, loadRecentSearches]);

  // Search candidate entities via MCA Provider
  async function handleSearchCandidates(e) {
    if (e) e.preventDefault();
    const q = lookupQuery.trim();
    if (!q) return;

    setSearchingCandidates(true);
    setLookupError('');
    setCandidates([]);
    setShowCandidatePicker(false);
    setLookupResult(null);

    try {
      const res = await fetch(`${API_BASE}/api/training/intel/search-companies?q=${encodeURIComponent(q)}`);
      const json = await res.json();

      if (!json.success) {
        setLookupError(json.message || 'Data provider unavailable, try again');
        return;
      }

      const list = Array.isArray(json.data) ? json.data : [];
      if (list.length === 0) {
        setLookupError(`No registered corporate entity found for "${q}"`);
        return;
      }

      // Check for exact single match
      const exactMatch = list.length === 1 && list[0].name.toLowerCase() === q.toLowerCase();
      if (exactMatch && list[0].cin) {
        fetchCompanyDossier(list[0]);
      } else {
        setCandidates(list);
        setShowCandidatePicker(true);
      }
    } catch (err) {
      setLookupError(err.message || 'Data provider unavailable, try again');
    } finally {
      setSearchingCandidates(false);
    }
  }

  // Fetch Unified Dossier for selected candidate CIN
  async function fetchCompanyDossier(candidate) {
    if (!candidate?.cin) return;
    setSelectedCandidate(candidate);
    setLoadingDossier(true);
    setLookupError('');
    setShowCandidatePicker(false);

    try {
      const res = await fetch(`${API_BASE}/api/training/intel/company/${encodeURIComponent(candidate.cin)}/dossier?q=${encodeURIComponent(candidate.name || lookupQuery)}`);
      const json = await res.json();

      if (json.success && json.data) {
        setLookupResult(json.data);
        loadRecentSearches();
      } else {
        setLookupError(json.message || 'Failed to fetch verified dossier');
      }
    } catch (err) {
      setLookupError(err.message || 'Data provider unavailable, try again');
    } finally {
      setLoadingDossier(false);
    }
  }

  async function handleSyncZoho(id) {
    try {
      setSyncingZohoId(id);
      const res = await fetch(`${API_BASE}/api/training/intel/${id}/sync-zoho`, {
        method: 'POST',
      });
      const json = await res.json();
      if (json.success) {
        setBanner(`✅ Successfully synced ${json.data.company_name} to Zoho CRM Accounts & Lead 360!`);
        setIntelList((prev) => prev.map((item) => (item.id === id ? json.data : item)));
        loadIntel({ silent: true });
      } else {
        setError(json.message || 'Zoho sync failed');
      }
    } catch (err) {
      setError(err.message || 'Zoho sync request failed');
    } finally {
      setSyncingZohoId(null);
    }
  }

  const filteredIntel = useMemo(() => {
    return intelList.filter((item) => {
      if (tempFilter && item.lead_temperature?.toLowerCase() !== tempFilter.toLowerCase()) return false;
      if (search) {
        const q = search.toLowerCase();
        const matchesCompany = item.company_name?.toLowerCase().includes(q);
        const matchesContact = item.contact_name?.toLowerCase().includes(q);
        const matchesLocation = item.location?.toLowerCase().includes(q);
        if (!matchesCompany && !matchesContact && !matchesLocation) return false;
      }
      return true;
    });
  }, [intelList, search, tempFilter]);

  const stats = useMemo(() => {
    let hot = 0;
    let warm = 0;
    let cold = 0;
    let synced = 0;
    for (const item of intelList) {
      const t = item.lead_temperature?.toLowerCase();
      if (t === 'hot') hot += 1;
      else if (t === 'cold') cold += 1;
      else warm += 1;
      if (item.synced_to_zoho) synced += 1;
    }
    return { total: intelList.length, hot, warm, cold, synced };
  }, [intelList]);

  return (
    <section className="page-stack" style={{ gap: '1.25rem' }}>
      {/* Header Banner */}
      <section style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div className="eyebrow" style={{ color: '#2563eb', marginBottom: '0.25rem' }}>Client 360° Intelligence</div>
            <h3 style={{ margin: '0 0 0.35rem 0', fontSize: '1.4rem', color: '#0f172a' }}>
              🏢 Client Intel Hub
            </h3>
            <p style={{ margin: 0, color: '#475569', fontSize: '0.9rem', maxWidth: '780px' }}>
              Real audited corporate data (Turnover, Employees, Plants from MCA) and call speech insights for prospect clients dialed by BD executives.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="secondary-button"
              onClick={handleSyncCalls}
              disabled={syncingCalls}
              style={{ fontSize: '0.82rem', padding: '0.4rem 0.85rem', background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', cursor: 'pointer' }}
            >
              {syncingCalls ? '⚡ Processing Calls...' : '⚡ Sync Real Calls'}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => loadIntel({ silent: false })}
              style={{ fontSize: '0.82rem', padding: '0.4rem 0.85rem' }}
            >
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* Stats Strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginTop: '1.2rem' }}>
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '0.75rem 0.95rem' }}>
            <span style={{ fontSize: '0.74rem', color: '#64748b', fontWeight: 600 }}>Total Clients Dialed</span>
            <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#0f172a', marginTop: '0.1rem' }}>{stats.total}</div>
          </div>
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '12px', padding: '0.75rem 0.95rem' }}>
            <span style={{ fontSize: '0.74rem', color: '#991b1b', fontWeight: 600 }}>🔥 Hot Leads</span>
            <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#b91c1c', marginTop: '0.1rem' }}>{stats.hot}</div>
          </div>
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '12px', padding: '0.75rem 0.95rem' }}>
            <span style={{ fontSize: '0.74rem', color: '#92400e', fontWeight: 600 }}>☀️ Warm Prospects</span>
            <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#d97706', marginTop: '0.1rem' }}>{stats.warm}</div>
          </div>
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '12px', padding: '0.75rem 0.95rem' }}>
            <span style={{ fontSize: '0.74rem', color: '#166534', fontWeight: 600 }}>✅ Synced to Zoho CRM</span>
            <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#15803d', marginTop: '0.1rem' }}>{stats.synced}</div>
          </div>
        </div>

        {banner ? (
          <div style={{ marginTop: '1rem', padding: '0.7rem 1rem', borderRadius: '10px', background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0', fontSize: '0.88rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{banner}</span>
            <button type="button" onClick={() => setBanner('')} style={{ background: 'none', border: 'none', color: '#065f46', cursor: 'pointer', fontWeight: 700 }}>✕</button>
          </div>
        ) : null}
        {error ? <div className="status-card error" style={{ marginTop: '0.85rem' }}>{error}</div> : null}
      </section>

      {/* PRE-PITCH REAL COMPANY SEARCH */}
      <section style={{ ...panelStyle, display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.2rem' }}>🔍</span>
          <div>
            <strong style={{ fontSize: '0.98rem', color: '#0f172a' }}>Pre-Pitch Company Intelligence (Section A Search)</strong>
            <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.82rem', color: '#64748b' }}>
              Search target company by registered legal name. Select candidate entity to load official MCA filings and financial statements. Zero mock data.
            </p>
          </div>
          <span style={{ marginLeft: 'auto', fontSize: '0.74rem', background: '#dcfce7', color: '#166534', fontWeight: 700, padding: '0.2rem 0.6rem', borderRadius: '6px' }}>
            Official MCA Pipeline
          </span>
        </div>

        <form onSubmit={handleSearchCandidates} style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Enter company legal name to search MCA registry..."
            value={lookupQuery}
            onChange={(e) => setLookupQuery(e.target.value)}
            style={{ flex: 1, minWidth: '280px', padding: '0.6rem 0.9rem', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '0.9rem' }}
          />
          <button
            type="submit"
            className="primary-button"
            disabled={searchingCandidates || !lookupQuery.trim()}
            style={{ padding: '0.6rem 1.25rem', fontSize: '0.88rem' }}
          >
            {searchingCandidates ? 'Searching MCA...' : '🔍 Search MCA Candidates'}
          </button>
        </form>

        {/* Quick Lookup Chips - Render ONLY user's own recent real searches */}
        {recentSearches && recentSearches.length > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', fontSize: '0.78rem', color: '#64748b' }}>
            <span>Recent Searches:</span>
            {recentSearches.map((item) => (
              <button
                key={item.cin || item.name}
                type="button"
                onClick={() => {
                  setLookupQuery(item.name);
                  if (item.cin) {
                    fetchCompanyDossier({ cin: item.cin, name: item.name });
                  } else {
                    handleSearchCandidates();
                  }
                }}
                style={{
                  background: '#f8fafc',
                  border: '1px solid #cbd5e1',
                  borderRadius: '999px',
                  padding: '0.2rem 0.65rem',
                  cursor: 'pointer',
                  fontSize: '0.76rem',
                  color: '#334155',
                }}
              >
                {item.name}
              </button>
            ))}
          </div>
        ) : null}

        {/* Candidate Picker Modal/Card */}
        {showCandidatePicker && candidates.length > 0 ? (
          <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '12px', padding: '1rem', marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div>
                <strong style={{ fontSize: '0.92rem', color: '#0f172a' }}>
                  Select MCA Registered Entity ({candidates.length} match{candidates.length > 1 ? 'es' : ''})
                </strong>
                <span style={{ display: 'block', fontSize: '0.74rem', color: '#64748b' }}>
                  Please select the exact legal entity to load its audited financial dossier.
                </span>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setShowCandidatePicker(false)}
                style={{ fontSize: '0.74rem', padding: '0.15rem 0.45rem' }}
              >
                ✕ Cancel
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {candidates.map((cand) => (
                <div
                  key={cand.cin}
                  style={{
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '0.75rem 1rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                  }}
                >
                  <div>
                    <strong style={{ fontSize: '0.9rem', color: '#1e293b' }}>{cand.name}</strong>
                    <div style={{ fontSize: '0.76rem', color: '#64748b', marginTop: '0.15rem', display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
                      <span>CIN: <strong>{cand.cin}</strong></span>
                      {cand.state ? <span>State: {cand.state}</span> : null}
                      {cand.status ? (
                        <span style={{ color: cand.status.toLowerCase().includes('active') ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
                          Status: {cand.status}
                        </span>
                      ) : null}
                      {cand.incorporation_date ? <span>Inc: {cand.incorporation_date}</span> : null}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="primary-button"
                    disabled={loadingDossier}
                    onClick={() => fetchCompanyDossier(cand)}
                    style={{ fontSize: '0.78rem', padding: '0.35rem 0.8rem' }}
                  >
                    Select Entity & Load Dossier →
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Loading State */}
        {loadingDossier ? (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: '#2563eb', fontSize: '0.88rem', background: '#eff6ff', borderRadius: '10px' }}>
            ⏳ Fetching official MCA master data, balance sheet filings & website contact info for <strong>{selectedCandidate?.name || lookupQuery}</strong>...
          </div>
        ) : null}

        {/* Error Notice */}
        {lookupError ? (
          <div style={{ padding: '0.75rem 1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#991b1b', fontSize: '0.84rem' }}>
            ⚠️ {lookupError}
          </div>
        ) : null}

        {/* Unified Dossier Preview */}
        {lookupResult ? (
          <div style={{ marginTop: '0.6rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.45rem' }}>
              <span style={{ fontSize: '0.84rem', fontWeight: 700, color: '#15803d' }}>
                🎯 Unified Pre-Pitch Dossier (Zero Mock Data)
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setLookupResult(null)}
                style={{ fontSize: '0.74rem', padding: '0.15rem 0.45rem' }}
              >
                ✕ Close
              </button>
            </div>
            <ClientIntelCard intel={lookupResult} />
          </div>
        ) : null}
      </section>

      {/* EXTRACTED CLIENT INTEL LIST */}
      <section style={{ ...panelStyle, display: 'flex', flexDirection: 'column', gap: '1.15rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '1.15rem', color: '#0f172a' }}>
              📞 Clients Dialed by BD Executives
            </h4>
            <span style={{ fontSize: '0.82rem', color: '#64748b' }}>
              Showing <strong>{filteredIntel.length}</strong> of {intelList.length} verified prospect profiles
            </span>
          </div>

          <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Search by company, contact, or city..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ padding: '0.45rem 0.75rem', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '0.84rem', width: '240px' }}
            />

            <select
              value={tempFilter}
              onChange={(e) => setTempFilter(e.target.value)}
              style={{ padding: '0.45rem 0.75rem', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '0.84rem', background: '#fff' }}
            >
              <option value="">All Temperatures</option>
              <option value="Hot">🔥 Hot Leads</option>
              <option value="Warm">☀️ Warm Leads</option>
              <option value="Cold">❄️ Cold Leads</option>
            </select>
          </div>
        </div>

        {loading ? <div className="status-card">Loading client intel data...</div> : null}

        {!loading && filteredIntel.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
            {filteredIntel.map((intel) => (
              <ClientIntelCard
                key={intel.id}
                intel={intel}
                onSyncZoho={handleSyncZoho}
                syncing={syncingZohoId === intel.id}
              />
            ))}
          </div>
        ) : !loading ? (
          <div className="status-card muted" style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🏢</div>
            <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '1rem' }}>No Client Intel Found</div>
            <p style={{ margin: '0.4rem auto 0 auto', maxWidth: '500px', fontSize: '0.85rem', color: '#64748b' }}>
              When BD executives complete calls with prospect clients, the system automatically analyzes speech transcripts and pairs them with official MCA balance sheets.
            </p>
          </div>
        ) : null}
      </section>
    </section>
  );
}
