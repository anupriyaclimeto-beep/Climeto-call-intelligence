import dotenv from 'dotenv';
import { persistDb, upsertLeadFromZoho } from '../db.js';

dotenv.config();

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Exchange refresh_token for a fresh access_token via Zoho OAuth.
 */
export async function getZohoAccessToken(options = {}) {
  const clientId = options.clientId || process.env.ZOHO_CLIENT_ID || '';
  const clientSecret = options.clientSecret || process.env.ZOHO_CLIENT_SECRET || '';
  const refreshToken = options.refreshToken || process.env.ZOHO_REFRESH_TOKEN || '';
  const accountsUrl = (
    options.accountsUrl ||
    process.env.ZOHO_ACCOUNTS_URL ||
    'https://accounts.zoho.in'
  ).replace(/\/+$/, '');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Zoho credentials missing (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN).');
  }

  // Use cached token if still valid (with 60-second buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Zoho token request failed (${response.status}): ${errorText || response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Zoho OAuth error: ${data.error}`);
  }

  cachedToken = {
    accessToken: data.access_token,
    apiDomain: data.api_domain || process.env.ZOHO_API_BASE_URL || 'https://www.zohoapis.in',
    tokenType: data.token_type || 'Bearer',
  };

  const expiresInSec = Number(data.expires_in || 3600);
  tokenExpiresAt = Date.now() + expiresInSec * 1000;

  return cachedToken;
}

function mapLeadHotness(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('qualified') || s.includes('hot') || s.includes('proposal') || s.includes('negotiation')) {
    return 'hot';
  }
  if (s.includes('lost') || s.includes('junk') || s.includes('not interested') || s.includes('unqualified')) {
    return 'cold';
  }
  return 'warm';
}

/**
 * Fetch records from a Zoho CRM module (Leads, Contacts) with pagination.
 */
async function fetchModuleRecords(moduleName, { accessToken, apiDomain, maxPages = 5 }) {
  const records = [];
  let page = 1;

  while (page <= maxPages) {
    const url = `${apiDomain.replace(/\/+$/, '')}/crm/v2/${moduleName}?page=${page}&per_page=100`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (response.status === 204) {
      // 204 No Content = no more records
      break;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Failed to fetch ${moduleName} page ${page} (${response.status}): ${errorText}`);
    }

    const json = await response.json();
    const data = Array.isArray(json.data) ? json.data : [];
    if (!data.length) break;

    records.push(...data);

    if (!json.info?.more_records) break;
    page++;
  }

  return records;
}

/**
 * Main Sync Function: Pulls Leads and Contacts from Zoho CRM and upserts into local DB.
 */
export async function syncZohoCrm(options = {}) {
  const clientId = options.clientId || process.env.ZOHO_CLIENT_ID || '';
  const clientSecret = options.clientSecret || process.env.ZOHO_CLIENT_SECRET || '';
  const refreshToken = options.refreshToken || process.env.ZOHO_REFRESH_TOKEN || '';
  const crmBaseUrl = (
    options.crmBaseUrl ||
    process.env.ZOHO_CRM_BASE_URL ||
    'https://crm.zoho.in/crm/tab/Leads'
  ).replace(/\/+$/, '');

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      ok: false,
      skipped: true,
      message: 'Zoho credentials not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN in .env.',
    };
  }

  let totalProcessed = 0;
  let totalInserted = 0;
  let totalUpdated = 0;

  try {
    const { accessToken, apiDomain } = await getZohoAccessToken(options);

    // 1. Fetch and upsert Leads
    try {
      const zohoLeads = await fetchModuleRecords('Leads', { accessToken, apiDomain });
      for (const item of zohoLeads) {
        totalProcessed++;
        const clientName =
          item.Full_Name ||
          `${item.First_Name || ''} ${item.Last_Name || ''}`.trim() ||
          item.Company ||
          'Unnamed Lead';
        const clientPhone = item.Phone || item.Mobile || '';
        const email = item.Email || '';
        const company = item.Company || clientName;
        const stage = item.Lead_Status || 'Contacted';
        const ownerId = item.Owner?.name || item.Owner?.id || 'Zoho User';
        const hotness = mapLeadHotness(stage);
        const latestSummary = item.Description || `Synced from Zoho CRM (Status: ${stage})`;
        const nextAction = 'Review in Zoho CRM';
        const zohoUrl = `${crmBaseUrl}/${item.id}`;

        const result = upsertLeadFromZoho({
          id: `zoho-lead-${item.id}`,
          clientName,
          clientPhone,
          email,
          company,
          stage,
          ownerId,
          hotness,
          latestSummary,
          nextAction,
          zohoUrl,
        });

        if (result.inserted) totalInserted++;
        if (result.updated) totalUpdated++;
      }
    } catch (leadErr) {
      console.warn('[Zoho Sync] Warning fetching Leads:', leadErr.message);
    }

    // 2. Fetch and upsert Contacts
    try {
      const zohoContacts = await fetchModuleRecords('Contacts', { accessToken, apiDomain });
      for (const item of zohoContacts) {
        totalProcessed++;
        const clientName =
          item.Full_Name ||
          `${item.First_Name || ''} ${item.Last_Name || ''}`.trim() ||
          item.Account_Name?.name ||
          'Unnamed Contact';
        const clientPhone = item.Phone || item.Mobile || '';
        const email = item.Email || '';
        const company = item.Account_Name?.name || clientName;
        const stage = 'Customer / Contact';
        const ownerId = item.Owner?.name || 'Zoho User';
        const hotness = 'warm';
        const latestSummary = item.Description || 'Contact record from Zoho CRM';
        const nextAction = 'Follow up via Zoho CRM';
        const zohoUrl = `https://crm.zoho.in/crm/tab/Contacts/${item.id}`;

        const result = upsertLeadFromZoho({
          id: `zoho-contact-${item.id}`,
          clientName,
          clientPhone,
          email,
          company,
          stage,
          ownerId,
          hotness,
          latestSummary,
          nextAction,
          zohoUrl,
        });

        if (result.inserted) totalInserted++;
        if (result.updated) totalUpdated++;
      }
    } catch (contactErr) {
      console.warn('[Zoho Sync] Warning fetching Contacts:', contactErr.message);
    }

    persistDb();

    return {
      ok: true,
      processed: totalProcessed,
      inserted: totalInserted,
      updated: totalUpdated,
      syncedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[Zoho Sync] Error during sync:', err.message);
    return {
      ok: false,
      error: err.message || String(err),
    };
  }
}
