import React, { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4200';

function SourcePill({ source, derivedBy, confidence }) {
  if (!source) return null;
  let label = source;
  let bg = '#f1f5f9';
  let color = '#475569';
  let border = '#cbd5e1';

  if (source === 'mca') {
    label = 'MCA';
    bg = '#dcfce7';
    color = '#15803d';
    border = '#bbf7d0';
  } else if (source === 'financial_filing') {
    label = 'Filing';
    bg = '#dbeafe';
    color = '#1d4ed8';
    border = '#bfdbfe';
  } else if (source === 'company_website') {
    label = 'Website';
    bg = '#fef3c7';
    color = '#92400e';
    border = '#fde68a';
  } else if (source === 'ai_summary' || derivedBy === 'ai') {
    label = 'AI-derived';
    bg = '#f3e8ff';
    color = '#7e22ce';
    border = '#e9d5ff';
  } else if (source === 'call_ai' || source === 'call_transcript') {
    label = 'Call Speech';
    bg = '#ecfdf5';
    color = '#047857';
    border = '#a7f3d0';
  } else if (source === 'human_verified') {
    label = 'Verified by BD';
    bg = '#e0e7ff';
    color = '#3730a3';
    border = '#c7d2fe';
  }

  return (
    <span
      title={`Source: ${source}${confidence ? ` (${Math.round(confidence * 100)}% confidence)` : ''}`}
      style={{
        fontSize: '0.65rem',
        fontWeight: 700,
        padding: '0.1rem 0.35rem',
        borderRadius: '4px',
        background: bg,
        color: color,
        border: `1px solid ${border}`,
        marginLeft: '0.35rem',
        display: 'inline-flex',
        alignItems: 'center',
        verticalAlign: 'middle',
      }}
    >
      [{label}]
    </span>
  );
}

function FieldDisplay({ label, field, fallback = 'Not available', isLink = false, onShowEvidence = null }) {
  const val = field && typeof field === 'object' && 'value' in field ? field.value : field;
  const source = field?.source;
  const derivedBy = field?.derived_by;
  const confidence = field?.confidence;
  const evidence = field?.evidence;
  const timestamp = field?.timestamp;
  const needsReview = Boolean(field?.needs_review);

  const hasValue = val !== null && val !== undefined && val !== '';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
        <span style={{ color: '#64748b', fontSize: '0.73rem' }}>{label}</span>
        {needsReview ? (
          <span
            style={{
              fontSize: '0.62rem',
              fontWeight: 700,
              padding: '0.05rem 0.35rem',
              borderRadius: '4px',
              background: '#ffedd5',
              color: '#c2410c',
              border: '1px solid #fdba74',
            }}
          >
            ⚠️ Needs review
          </span>
        ) : null}
      </div>

      {hasValue ? (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem' }}>
          {isLink ? (
            <a
              href={String(val).startsWith('http') ? val : `https://${val}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: '#2563eb', textDecoration: 'none', wordBreak: 'break-all', fontSize: '0.84rem' }}
            >
              {val}
            </a>
          ) : (
            <strong style={{ color: '#0f172a', fontSize: '0.84rem' }}>{val}</strong>
          )}

          <SourcePill source={source} derivedBy={derivedBy} confidence={confidence} />

          {evidence && onShowEvidence ? (
            <button
              type="button"
              onClick={() => onShowEvidence({ label, value: val, evidence, timestamp, confidence, needsReview, source })}
              title="Click to view verbatim transcript evidence quote"
              style={{
                background: '#f1f5f9',
                border: '1px solid #cbd5e1',
                borderRadius: '4px',
                padding: '0.1rem 0.35rem',
                fontSize: '0.66rem',
                color: '#334155',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.2rem',
              }}
            >
              💬 {timestamp ? timestamp : 'Quote'}
            </button>
          ) : null}
        </div>
      ) : (
        <span style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: '0.8rem' }}>{fallback}</span>
      )}
    </div>
  );
}

function tempBadge(temp = '') {
  if (!temp) return null;
  const t = String(temp).toLowerCase();
  if (t === 'hot') {
    return { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5', icon: '🔥', label: 'HOT' };
  }
  if (t === 'warm') {
    return { bg: '#fef3c7', text: '#92400e', border: '#fcd34d', icon: '☀️', label: 'WARM' };
  }
  if (t === 'cold') {
    return { bg: '#e0f2fe', text: '#075985', border: '#bae6fd', icon: '❄️', label: 'COLD' };
  }
  return null;
}

export default function ClientIntelCard({ intel, onSyncZoho, syncing = false, callId = null, onFieldUpdated = null }) {
  const [copied, setCopied] = useState(false);
  const [activeEvidence, setActiveEvidence] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [patching, setPatching] = useState(false);

  if (!intel) {
    return (
      <div style={{ padding: '1rem', background: '#f8fafc', borderRadius: '12px', border: '1px dashed #cbd5e1', fontSize: '0.85rem', color: '#64748b', textAlign: 'center' }}>
        No Client Intel available. Search a company above or dial a client to generate verified intelligence.
      </div>
    );
  }

  const isUnified = Boolean(intel.section_a);
  const secA = isUnified ? intel.section_a : intel;
  const secB = isUnified ? intel.section_b : (intel.contact_name ? intel : null);
  const secC = isUnified ? intel.section_c : (intel.client_requirement ? intel : null);

  const getVal = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f) || null;
  const getSrc = (f) => (f && typeof f === 'object' && 'source' in f ? f.source : null) || '';

  const companyName = getVal(secA?.company_name) || 'Unnamed Company';
  const cin = getVal(secA?.cin);
  const turnover = getVal(secA?.annual_turnover);
  const turnoverSrc = getSrc(secA?.annual_turnover);
  const companyType = getVal(secA?.company_type);
  const employees = getVal(secA?.employee_count);
  const website = getVal(secA?.website);
  const location = getVal(secA?.registered_address) || getVal(secA?.location) || getVal(secA?.state);

  function copySummary() {
    const parts = [
      `COMPANY: ${companyName}${companyType ? ` (${companyType})` : ''} ${cin ? `| CIN: ${cin} [MCA]` : ''}`,
      `Turnover: ${turnover || 'Not available'} ${turnoverSrc ? `[${turnoverSrc}]` : ''}`,
      `Employees: ${employees || 'Not available'} | Location: ${location || 'Not available'}`,
      `Website: ${website || 'Not available'}`,
    ];

    if (secB) {
      const dept = getVal(secB.department || secB.contact_department);
      const headcount = getVal(secB.company_headcount || secA?.employee_count);
      parts.push(`CONTACT: ${getVal(secB.contact_name) || 'Not mentioned in call'} (${getVal(secB.designation) || getVal(secB.contact_designation) || 'Role not stated'}${dept ? ` - ${dept}` : ''}) | Phone: ${getVal(secB.phone) || getVal(secB.contact_phone) || 'Not stated'}${headcount ? ` | Headcount: ${headcount}` : ''}`);
    } else {
      parts.push('CONTACT: No call analysed yet');
    }

    if (secC) {
      parts.push(`REQUIREMENT: ${getVal(secC.client_requirement) || 'Not mentioned in call'} | Problem: ${getVal(secC.main_problem) || 'Not stated'}`);
    } else {
      parts.push('SALES INTEL: No call analysed yet');
    }

    navigator.clipboard.writeText(parts.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const tb = secC ? tempBadge(getVal(secC.lead_temperature)) : null;

  async function handleSaveManualEdit() {
    if (!callId || !activeEvidence) return;
    setPatching(true);
    try {
      const fieldKey = activeEvidence.fieldKey || activeEvidence.label.toLowerCase().replace(/\s+/g, '_');
      const res = await fetch(`${API_BASE}/api/calls/${encodeURIComponent(callId)}/fields/${encodeURIComponent(fieldKey)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: editValue }),
      });
      const json = await res.json();
      if (json.success) {
        setIsEditing(false);
        setActiveEvidence(null);
        if (onFieldUpdated) onFieldUpdated();
      }
    } catch {
      // ignore
    } finally {
      setPatching(false);
    }
  }

  return (
    <div
      style={{
        background: '#ffffff',
        border: '1px solid #cbd5e1',
        borderRadius: '16px',
        padding: '1.25rem',
        boxShadow: '0 4px 12px rgba(15, 23, 42, 0.05)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        position: 'relative',
      }}
    >
      {/* Header bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem', borderBottom: '1px solid #f1f5f9', paddingBottom: '0.8rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 800, padding: '0.2rem 0.6rem', borderRadius: '6px', background: '#e0e7ff', color: '#3730a3', textTransform: 'uppercase' }}>
            Unified Dossier
          </span>
          <strong style={{ fontSize: '1.05rem', color: '#0f172a' }}>{companyName}</strong>
          {cin ? (
            <span style={{ fontSize: '0.74rem', color: '#16a34a', background: '#dcfce7', padding: '0.15rem 0.5rem', borderRadius: '6px', fontWeight: 700 }}>
              🛡️ MCA CIN: {cin}
            </span>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            type="button"
            className="ghost-button"
            onClick={copySummary}
            style={{ fontSize: '0.78rem', padding: '0.3rem 0.65rem' }}
          >
            {copied ? '✅ Copied' : '📋 Copy Intel'}
          </button>

          {onSyncZoho && intel.id ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => onSyncZoho(intel.id)}
              disabled={syncing || intel.synced_to_zoho}
              style={{
                fontSize: '0.78rem',
                padding: '0.35rem 0.8rem',
                background: intel.synced_to_zoho ? '#16a34a' : '#2563eb',
                borderColor: intel.synced_to_zoho ? '#16a34a' : '#2563eb',
              }}
            >
              {syncing ? 'Syncing...' : intel.synced_to_zoho ? '✅ Synced to Zoho' : '⚡ Push to Zoho CRM'}
            </button>
          ) : null}
        </div>
      </div>

      {/* 3-Panel Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
        }}
      >
        {/* PANEL A: Company Profile */}
        <div
          style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.6rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.45rem' }}>
            <span style={{ fontSize: '1.05rem' }}>🏢</span>
            <strong style={{ fontSize: '0.9rem', color: '#1e293b' }}>A. Company Profile</strong>
            <span style={{ fontSize: '0.68rem', color: '#15803d', fontWeight: 700, marginLeft: 'auto', background: '#dcfce7', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>
              Official Data
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.82rem' }}>
            <FieldDisplay label="Company Name" field={secA?.company_name} />
            <FieldDisplay label="CIN" field={secA?.cin} />
            <FieldDisplay label="Annual Turnover" field={secA?.annual_turnover} />
            <FieldDisplay label="Company Type" field={secA?.company_type} />
            <FieldDisplay label="Employee Count" field={secA?.employee_count} />
            <FieldDisplay label="Website" field={secA?.website} isLink />
            <FieldDisplay label="Company Email" field={secA?.company_email} />
            <FieldDisplay label="Company Phone" field={secA?.company_phone} />

            <div style={{ gridColumn: 'span 2' }}>
              <FieldDisplay label="Location / Registered Address" field={secA?.registered_address || secA?.location || secA?.state} />
            </div>

            <div style={{ gridColumn: 'span 2' }}>
              <FieldDisplay label="Industry" field={secA?.industry} />
            </div>

            {secA?.business_category ? (
              <div style={{ gridColumn: 'span 2' }}>
                <FieldDisplay label="Business Category" field={secA?.business_category} />
              </div>
            ) : null}
          </div>
        </div>

        {/* PANEL B: Contact Person Profile */}
        <div
          style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.6rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.45rem' }}>
            <span style={{ fontSize: '1.05rem' }}>👤</span>
            <strong style={{ fontSize: '0.9rem', color: '#1e293b' }}>B. Contact Person Profile</strong>
            <span style={{ fontSize: '0.68rem', color: '#64748b', marginLeft: 'auto' }}>
              {secB ? 'Evidence-Backed Call Speech' : 'Pre-Pitch'}
            </span>
          </div>

          {secB ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.82rem' }}>
              <FieldDisplay label="Contact Name" field={secB.contact_name} fallback="Not mentioned in call" onShowEvidence={setActiveEvidence} />
              <FieldDisplay label="Designation" field={secB.designation || secB.contact_designation} fallback="Not stated" onShowEvidence={setActiveEvidence} />
              <FieldDisplay label="Department" field={secB.department || secB.contact_department} fallback="Not stated" onShowEvidence={setActiveEvidence} />
              <FieldDisplay label="Company Headcount" field={secB.company_headcount || secA?.employee_count} fallback="Not available" onShowEvidence={setActiveEvidence} />
              <FieldDisplay label="Phone" field={secB.phone || secB.contact_phone} fallback="Not stated" onShowEvidence={setActiveEvidence} />
              <FieldDisplay label="Email" field={secB.email || secB.contact_email} fallback="Not stated" onShowEvidence={setActiveEvidence} />
              <FieldDisplay label="Seniority" field={secB.seniority} fallback="Not stated" onShowEvidence={setActiveEvidence} />
              <FieldDisplay label="Decision Authority" field={secB.decision_authority || secB.decision_maker} fallback="Not stated" onShowEvidence={setActiveEvidence} />
            </div>
          ) : (
            <div style={{ padding: '2rem 1rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.84rem' }}>
              <div style={{ fontSize: '1.4rem', marginBottom: '0.3rem' }}>📞</div>
              <strong style={{ color: '#64748b' }}>No call analysed yet</strong>
              <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.74rem' }}>
                Contact details will populate automatically after BD executive dials this client.
              </p>
            </div>
          )}
        </div>

        {/* PANEL C: Sales Intelligence */}
        <div
          style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.6rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.45rem' }}>
            <span style={{ fontSize: '1.05rem' }}>🎯</span>
            <strong style={{ fontSize: '0.9rem', color: '#1e293b' }}>C. Sales Intelligence</strong>
            {tb ? (
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  padding: '0.15rem 0.5rem',
                  borderRadius: '6px',
                  background: tb.bg,
                  color: tb.text,
                  border: `1px solid ${tb.border}`,
                }}
              >
                {tb.icon} {tb.label}
              </span>
            ) : (
              <span style={{ fontSize: '0.68rem', color: '#64748b', marginLeft: 'auto' }}>
                {secC ? 'Call Intelligence' : 'Pre-Pitch'}
              </span>
            )}
          </div>

          {secC ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.82rem' }}>
              <FieldDisplay label="Lead Source" field={secC.lead_source} fallback="Calling" />
              <FieldDisplay label="Current Vendor" field={secC.current_vendor} fallback="Not disclosed" onShowEvidence={setActiveEvidence} />
              <div style={{ gridColumn: 'span 2' }}>
                <FieldDisplay label="Client Requirement" field={secC.client_requirement} fallback="Not mentioned in call" onShowEvidence={setActiveEvidence} />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <FieldDisplay label="Main Problem" field={secC.main_problem} fallback="Not stated" onShowEvidence={setActiveEvidence} />
              </div>
              <FieldDisplay label="Budget" field={secC.budget} fallback="Not disclosed" onShowEvidence={setActiveEvidence} />
              <FieldDisplay label="Last Interaction" field={secC.last_interaction} fallback="None" />
              <div style={{ gridColumn: 'span 2' }}>
                <FieldDisplay label="Next Follow-up" field={secC.next_followup} fallback="Not scheduled" onShowEvidence={setActiveEvidence} />
              </div>
            </div>
          ) : (
            <div style={{ padding: '2rem 1rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.84rem' }}>
              <div style={{ fontSize: '1.4rem', marginBottom: '0.3rem' }}>🎯</div>
              <strong style={{ color: '#64748b' }}>No call analysed yet</strong>
              <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.74rem' }}>
                Pain points, requirement & budget will emerge from call analysis.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* VERBATIM EVIDENCE INSPECTOR MODAL */}
      {activeEvidence ? (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(15, 23, 42, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '1rem',
          }}
          onClick={() => setActiveEvidence(null)}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: '16px',
              padding: '1.5rem',
              maxWidth: '520px',
              width: '100%',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.75rem', marginBottom: '1rem' }}>
              <div>
                <strong style={{ fontSize: '1.05rem', color: '#0f172a' }}>Verbatim Evidence Inspector</strong>
                <span style={{ display: 'block', fontSize: '0.76rem', color: '#64748b' }}>
                  Audited transcript proof for <strong>{activeEvidence.label}</strong>
                </span>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setActiveEvidence(null)}
                style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <div>
                <span style={{ fontSize: '0.74rem', color: '#64748b', display: 'block' }}>Extracted Value</span>
                <strong style={{ fontSize: '0.96rem', color: '#0f172a' }}>{activeEvidence.value || 'None'}</strong>
              </div>

              <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '10px', padding: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#047857', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    🎙️ Spoken Transcript Quote
                  </span>
                  {activeEvidence.timestamp ? (
                    <span style={{ fontSize: '0.72rem', background: '#e2e8f0', padding: '0.1rem 0.4rem', borderRadius: '4px', color: '#334155', fontWeight: 600 }}>
                      Timestamp: {activeEvidence.timestamp}
                    </span>
                  ) : null}
                </div>
                <blockquote style={{ margin: 0, fontStyle: 'italic', fontSize: '0.88rem', color: '#1e293b', lineHeight: 1.45 }}>
                  "{activeEvidence.evidence || 'No exact quote available'}"
                </blockquote>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', color: '#64748b' }}>
                <span>
                  Confidence Score:{' '}
                  <strong style={{ color: activeEvidence.confidence >= 0.8 ? '#15803d' : activeEvidence.confidence >= 0.6 ? '#d97706' : '#b91c1c' }}>
                    {Math.round((activeEvidence.confidence || 0) * 100)}%
                  </strong>
                </span>
                {activeEvidence.needsReview ? (
                  <span style={{ color: '#c2410c', fontWeight: 700 }}>⚠️ Low Confidence - Needs Review</span>
                ) : (
                  <span style={{ color: '#15803d', fontWeight: 700 }}>✅ Verified by Validation Layer</span>
                )}
              </div>

              {callId ? (
                <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '0.75rem', marginTop: '0.4rem' }}>
                  {!isEditing ? (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setIsEditing(true);
                        setEditValue(activeEvidence.value || '');
                      }}
                      style={{ fontSize: '0.78rem', width: '100%' }}
                    >
                      ✏️ Edit / Correct Value (Save as Human Verified)
                    </button>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        placeholder="Enter verified correct value..."
                        style={{ padding: '0.4rem 0.6rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.84rem' }}
                      />
                      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                        <button type="button" className="ghost-button" onClick={() => setIsEditing(false)} style={{ fontSize: '0.75rem' }}>Cancel</button>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={patching}
                          onClick={handleSaveManualEdit}
                          style={{ fontSize: '0.75rem' }}
                        >
                          {patching ? 'Saving...' : 'Save Correction'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
