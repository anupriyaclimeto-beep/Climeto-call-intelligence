/**
 * MCA Data Provider Adapter
 * 
 * Interacts with licensed MCA corporate data providers (Surepass / Attestr / Probe42 / Tofler).
 * 
 * Exports:
 * - searchByName(companyName) -> [{ cin, name, state, status, incorporation_date }]
 * - getMasterData(cin) -> { name, type, status, registered_address, state, incorporation_date, nic_code, nic_description }
 * - getFinancials(cin) -> { financial_year, turnover_inr }
 * 
 * STRICT RULES:
 * - Zero mock fallbacks. If provider is unconfigured or unavailable, throw a clean error.
 * - Do NOT scrape MCA portal or LinkedIn directly.
 * - Native fetch with AbortController (10s timeout) and 1 retry.
 */

function getProviderConfig() {
  const apiKey = String(process.env.MCA_PROVIDER_API_KEY || '').trim();
  const baseUrl = String(process.env.MCA_PROVIDER_BASE_URL || '').trim().replace(/\/+$/, '');
  return { apiKey, baseUrl, isConfigured: Boolean(apiKey) };
}

/**
 * Execute native fetch with timeout and 1 retry
 */
async function fetchWithRetry(url, options = {}, retries = 1, timeoutMs = 10000) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Provider HTTP ${res.status}: ${errorText || res.statusText}`);
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      attempt += 1;
      if (attempt <= retries) {
        // Small backoff before retry
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
  }

  throw new Error(`Data provider unavailable, try again (${lastError?.message || 'timeout'})`);
}

/**
 * Search companies by query string
 * Returns candidate list for user disambiguation
 */
export async function searchByName(companyName = '') {
  const query = String(companyName || '').trim();
  if (!query) return [];

  const { apiKey, baseUrl, isConfigured } = getProviderConfig();

  if (!isConfigured) {
    throw new Error('MCA Data provider not configured. Please set MCA_PROVIDER_API_KEY in backend/.env');
  }

  const endpoint = `${baseUrl}/company/search`;
  try {
    const payload = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ query, name: query }),
    });

    const candidates = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.candidates)
      ? payload.candidates
      : Array.isArray(payload?.results)
      ? payload.results
      : [];

    return candidates.map((c) => ({
      cin: c.cin || c.company_id || c.identification_number || '',
      name: c.company_name || c.name || '',
      state: c.registered_state || c.state || '',
      status: c.status || c.company_status || 'Active',
      incorporation_date: c.incorporation_date || c.date_of_incorporation || null,
    }));
  } catch (err) {
    if (err.message.includes('Data provider unavailable')) throw err;
    throw new Error(`Data provider unavailable, try again (${err.message})`);
  }
}

/**
 * Get official MCA master profile by CIN
 */
export async function getMasterData(cin = '') {
  const cleanCin = String(cin || '').trim();
  if (!cleanCin) throw new Error('CIN is required');

  const { apiKey, baseUrl, isConfigured } = getProviderConfig();

  if (!isConfigured) {
    throw new Error('MCA Data provider not configured. Please set MCA_PROVIDER_API_KEY in backend/.env');
  }

  const endpoint = `${baseUrl}/company/${encodeURIComponent(cleanCin)}/master-data`;
  try {
    const payload = await fetchWithRetry(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
      },
    });

    const d = payload?.data || payload || {};
    return {
      name: d.company_name || d.name || null,
      type: d.company_type || d.class_of_company || null,
      status: d.company_status || d.status || null,
      registered_address: d.registered_address || d.address || null,
      state: d.registered_state || d.state || null,
      incorporation_date: d.incorporation_date || d.date_of_incorporation || null,
      nic_code: d.nic_code || null,
      nic_description: d.nic_description || d.activity_description || null,
    };
  } catch (err) {
    if (err.message.includes('Data provider unavailable')) throw err;
    throw new Error(`Data provider unavailable, try again (${err.message})`);
  }
}

/**
 * Get latest filed financial statement figures (AOC-4 / XBRL filings)
 */
export async function getFinancials(cin = '') {
  const cleanCin = String(cin || '').trim();
  if (!cleanCin) throw new Error('CIN is required');

  const { apiKey, baseUrl, isConfigured } = getProviderConfig();

  if (!isConfigured) {
    throw new Error('MCA Data provider not configured. Please set MCA_PROVIDER_API_KEY in backend/.env');
  }

  const endpoint = `${baseUrl}/company/${encodeURIComponent(cleanCin)}/financials`;
  try {
    const payload = await fetchWithRetry(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
      },
    });

    const d = payload?.data || payload || {};
    return {
      financial_year: d.financial_year || d.latest_year || null,
      turnover_inr: d.turnover_inr != null ? d.turnover_inr : d.turnover != null ? d.turnover : null,
    };
  } catch (err) {
    if (err.message.includes('Data provider unavailable')) throw err;
    throw new Error(`Data provider unavailable, try again (${err.message})`);
  }
}
