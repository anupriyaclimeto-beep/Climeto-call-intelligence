/**
 * Dossier Merge Service
 * 
 * Merges official MCA master data, audited financial filings, verified website scrape,
 * and AI industry classification into a Unified Dossier (Section A + null Section B + null Section C).
 * 
 * STRICT RULES:
 * - Every Section A field is an object: { value, source, source_url, fetched_at, confidence, derived_by }
 * - Turnover MUST include financial_year (e.g. "INR 42.5 Cr (FY 2023-24)"). If financial year missing -> null.
 * - Missing fields have value: null (UI shows 'Not available' in grey).
 * - Pre-call dossier has section_b: null, section_c: null (UI shows 'No call analysed yet').
 */

function formatTurnover(turnoverInr, financialYear) {
  if (turnoverInr == null || !financialYear) return null;

  const fyLabel = String(financialYear).toLowerCase().startsWith('fy')
    ? String(financialYear).trim()
    : `FY ${financialYear}`;

  if (typeof turnoverInr === 'number') {
    if (turnoverInr >= 10000000) {
      const cr = (turnoverInr / 10000000).toFixed(1).replace(/\.0$/, '');
      return `INR ${cr} Cr (${fyLabel})`;
    } else if (turnoverInr >= 100000) {
      const lakh = (turnoverInr / 100000).toFixed(1).replace(/\.0$/, '');
      return `INR ${lakh} Lakh (${fyLabel})`;
    }
    return `INR ${turnoverInr.toLocaleString('en-IN')} (${fyLabel})`;
  }

  const str = String(turnoverInr).trim();
  if (!str) return null;
  return str.includes(fyLabel) ? str : `${str} (${fyLabel})`;
}

export function buildField({
  value = null,
  source = null,
  source_url = null,
  fetched_at = null,
  confidence = 0.0,
  derived_by = null,
} = {}) {
  const cleanVal = value !== undefined && value !== '' ? value : null;
  return {
    value: cleanVal,
    source: cleanVal !== null ? source : null,
    source_url: cleanVal !== null ? source_url : null,
    fetched_at: cleanVal !== null ? fetched_at : null,
    confidence: cleanVal !== null ? confidence : 0.0,
    derived_by: cleanVal !== null ? derived_by : null,
  };
}

export function mergeSectionA({
  mcaMaster = {},
  financials = {},
  websiteData = {},
  industryData = {},
  providerSourceUrl = null,
} = {}) {
  const now = new Date().toISOString();

  // 1. MCA Fields (Confidence 1.0, Source: 'mca', Derived: 'api')
  const company_name = buildField({
    value: mcaMaster.name,
    source: 'mca',
    source_url: providerSourceUrl,
    fetched_at: now,
    confidence: 1.0,
    derived_by: 'api',
  });

  const cin = buildField({
    value: mcaMaster.cin,
    source: 'mca',
    source_url: providerSourceUrl,
    fetched_at: now,
    confidence: 1.0,
    derived_by: 'api',
  });

  const company_type = buildField({
    value: mcaMaster.type,
    source: 'mca',
    source_url: providerSourceUrl,
    fetched_at: now,
    confidence: 1.0,
    derived_by: 'api',
  });

  const status = buildField({
    value: mcaMaster.status,
    source: 'mca',
    source_url: providerSourceUrl,
    fetched_at: now,
    confidence: 1.0,
    derived_by: 'api',
  });

  const state = buildField({
    value: mcaMaster.state,
    source: 'mca',
    source_url: providerSourceUrl,
    fetched_at: now,
    confidence: 1.0,
    derived_by: 'api',
  });

  const registered_address = buildField({
    value: mcaMaster.registered_address,
    source: 'mca',
    source_url: providerSourceUrl,
    fetched_at: now,
    confidence: 1.0,
    derived_by: 'api',
  });

  const incorporation_date = buildField({
    value: mcaMaster.incorporation_date,
    source: 'mca',
    source_url: providerSourceUrl,
    fetched_at: now,
    confidence: 1.0,
    derived_by: 'api',
  });

  // 2. Turnover (Confidence 1.0, Source: 'financial_filing', Derived: 'api')
  const formattedTurnover = formatTurnover(financials.turnover_inr, financials.financial_year);
  const annual_turnover = buildField({
    value: formattedTurnover,
    source: formattedTurnover ? 'financial_filing' : null,
    source_url: providerSourceUrl,
    fetched_at: now,
    confidence: formattedTurnover ? 1.0 : 0.0,
    derived_by: formattedTurnover ? 'api' : null,
  });

  // 3. Employee Count (Only if provider or website verified headcount exists)
  const empVal = mcaMaster.employee_count || websiteData.employee_count || null;
  const employee_count = buildField({
    value: empVal,
    source: empVal ? (mcaMaster.employee_count ? 'provider_estimate' : 'company_website') : null,
    source_url: websiteData.website || providerSourceUrl,
    fetched_at: now,
    confidence: empVal ? 0.7 : 0.0,
    derived_by: empVal ? 'scrape' : null,
  });

  // 4. Website, Email, Phone (Scraped literally from verified website)
  const website = buildField({
    value: websiteData.website || null,
    source: websiteData.website ? 'company_website' : null,
    source_url: websiteData.website || null,
    fetched_at: now,
    confidence: websiteData.website ? 0.8 : 0.0,
    derived_by: websiteData.website ? 'scrape' : null,
  });

  const company_email = buildField({
    value: websiteData.email || null,
    source: websiteData.email ? 'company_email' : null,
    source_url: websiteData.source_urls?.[0] || websiteData.website,
    fetched_at: now,
    confidence: websiteData.email ? 0.8 : 0.0,
    derived_by: websiteData.email ? 'scrape' : null,
  });

  const company_phone = buildField({
    value: websiteData.phone || null,
    source: websiteData.phone ? 'company_website' : null,
    source_url: websiteData.source_urls?.[0] || websiteData.website,
    fetched_at: now,
    confidence: websiteData.phone ? 0.8 : 0.0,
    derived_by: websiteData.phone ? 'scrape' : null,
  });

  // 5. Industry & Business Category
  const industry = buildField({
    value: industryData.industry || mcaMaster.nic_description || null,
    source: industryData.source || (mcaMaster.nic_description ? 'mca' : null),
    source_url: industryData.source === 'ai_summary' ? websiteData.website : providerSourceUrl,
    fetched_at: now,
    confidence: industryData.confidence || (mcaMaster.nic_description ? 1.0 : 0.0),
    derived_by: industryData.derived_by || (mcaMaster.nic_description ? 'api' : null),
  });

  const business_category = buildField({
    value: industryData.business_category || null,
    source: industryData.business_category ? 'ai_summary' : null,
    source_url: websiteData.website || null,
    fetched_at: now,
    confidence: industryData.business_category ? 0.6 : 0.0,
    derived_by: industryData.business_category ? 'ai' : null,
  });

  return {
    company_name,
    cin,
    company_type,
    status,
    state,
    registered_address,
    incorporation_date,
    annual_turnover,
    employee_count,
    website,
    company_email,
    company_phone,
    industry,
    business_category,
  };
}

/**
 * Creates the Unified Dossier structure:
 * Section A (Company Profile) + null Section B + null Section C
 */
export function createUnifiedDossier(sectionA) {
  return {
    section_a: sectionA,
    section_b: null,
    section_c: null,
  };
}
