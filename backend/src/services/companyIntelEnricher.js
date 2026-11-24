/**
 * Company Intel Enrichment Service
 * 
 * STRICT REAL DATA POLICY:
 * Zero hardcoded corporate registries, zero mock benchmark turnovers,
 * and zero fabricated emails or default placeholders.
 * Missing fields return null. UI renders 'Not available'.
 */

export function lookupVerifiedCompany(_query = '') {
  // Hardcoded corporate registry has been completely removed.
  return null;
}

/**
 * Clean domain helper without generating synthetic info@ emails
 */
export function normalizeDomain(raw = '') {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '');
}

/**
 * Fetch live website contact page strictly without guessing
 */
async function fetchLiveWebsiteContact(websiteUrl = '') {
  if (!websiteUrl) return null;
  const target = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(target, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ClimetoIntelligence/1.0 (+https://climeto.com)' },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;

    const html = await res.text();
    // Match literal mailto or explicit email in text
    const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    let email = mailtoMatch ? mailtoMatch[1] : null;

    if (!email) {
      const emailMatch = html.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/i);
      if (emailMatch && !emailMatch[1].endsWith('.png') && !emailMatch[1].endsWith('.jpg')) {
        email = emailMatch[1];
      }
    }

    return { email: email || null };
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Enrich company profile without generating fake numbers or emails.
 */
export async function enrichCompanyProfile({ companyName = '', domain = '', locationHint = '' } = {}) {
  const cleanName = String(companyName || '').trim();
  const cleanDomain = normalizeDomain(domain);
  const websiteUrl = cleanDomain ? `https://${cleanDomain}` : null;

  let liveEmail = null;
  if (websiteUrl) {
    try {
      const liveContact = await fetchLiveWebsiteContact(websiteUrl);
      if (liveContact?.email) liveEmail = liveContact.email;
    } catch {
      // ignore
    }
  }

  // Legal company type detection strictly from official name suffixes
  let companyType = null;
  if (/\b(pvt|private\s+limited)\b/i.test(cleanName)) {
    companyType = 'Private Limited';
  } else if (/\b(limited|ltd)\b/i.test(cleanName)) {
    companyType = 'Public Limited';
  } else if (/\b(llp|limited\s+liability)\b/i.test(cleanName)) {
    companyType = 'LLP';
  }

  return {
    company_name: cleanName || null,
    company_website: websiteUrl,
    industry: null,
    company_email: liveEmail,
    location: locationHint ? locationHint.trim() : null,
    employee_count: null,
    annual_turnover: null,
    company_type: companyType,
    business_category: null,
    is_verified: 0,
    extraction_source: liveEmail ? 'live_website_verified' : 'unverified',
  };
}
