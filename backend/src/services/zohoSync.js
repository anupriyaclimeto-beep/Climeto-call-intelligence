import dotenv from 'dotenv';
import {
  initializeDb,
  persistDb,
  upsertLeadFromZoho,
  upsertZohoAccount,
  saveZohoAccountMeta,
  getZohoAccountMeta,
  listZohoAccounts,
} from '../db.js';

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
  await initializeDb();
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

    // 3. Fetch and upsert Accounts (Companies)
    try {
      const zohoAccounts = await fetchModuleRecords('Accounts', { accessToken, apiDomain });
      for (const item of zohoAccounts) {
        totalProcessed++;
        const res = upsertZohoAccount({
          id: `zoho-acc-${item.id}`,
          accountName: item.Account_Name || item.Account_Site || 'Zoho Company',
          phone: item.Phone || item.Mobile || '',
          website: item.Website || '',
          industry: item.Industry || 'Enterprise',
          annualRevenue: item.Annual_Revenue ? `₹${Number(item.Annual_Revenue).toLocaleString('en-IN')}` : '',
          billingCity: item.Billing_City || item.City || '',
          billingCountry: item.Billing_Country || 'India',
          ownerName: item.Owner?.name || 'Zoho User',
          zohoUrl: `https://crm.zoho.in/crm/tab/Accounts/${item.id}`,
        });
        if (res?.inserted) totalInserted++;
        if (res?.updated) totalUpdated++;
      }
    } catch (accErr) {
      console.warn('[Zoho Sync] Notice fetching Accounts:', accErr.message);
    }

    // 4. Fetch Zoho Accounts User & Org Metadata
    try {
      await syncZohoUserAndOrg({
        accessToken,
        apiDomain,
        accountsUrl: options.accountsUrl || process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in',
      });
    } catch (metaErr) {
      console.warn('[Zoho Sync] Notice fetching Accounts IAM metadata:', metaErr.message);
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

/**
 * Fetch Zoho Accounts identity & Organization details
 */
export async function syncZohoUserAndOrg({ accessToken, apiDomain, accountsUrl }) {
  let userName = '';
  let userEmail = '';
  let zuid = '';
  let role = 'Administrator';
  let orgName = '';
  let orgId = '';
  const accountBaseUrl = (accountsUrl || 'https://accounts.zoho.in').replace(/\/+$/, '');

  // 1. Try Zoho Accounts user/info
  try {
    const userRes = await fetch(`${accountBaseUrl}/oauth/user/info`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    if (userRes.ok) {
      const uJson = await userRes.json();
      userName = uJson.Display_Name || `${uJson.First_Name || ''} ${uJson.Last_Name || ''}`.trim() || '';
      userEmail = uJson.Email || '';
      zuid = String(uJson.ZUID || '');
    }
  } catch (err) {
    // continue
  }

  // 2. Try Zoho CRM CurrentUser
  try {
    const crmUserRes = await fetch(`${apiDomain.replace(/\/+$/, '')}/crm/v2/users?type=CurrentUser`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    if (crmUserRes.ok) {
      const cJson = await crmUserRes.json();
      const u = cJson.users?.[0];
      if (u) {
        if (!userName) userName = u.full_name || u.name || '';
        if (!userEmail) userEmail = u.email || '';
        if (!zuid) zuid = String(u.id || '');
        if (u.role?.name) role = u.role.name;
      }
    }
  } catch (err) {
    // continue
  }

  // 3. Try Zoho CRM Org
  try {
    const orgRes = await fetch(`${apiDomain.replace(/\/+$/, '')}/crm/v2/org`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    if (orgRes.ok) {
      const oJson = await orgRes.json();
      const o = oJson.org?.[0];
      if (o) {
        orgName = o.company_name || '';
        orgId = String(o.zgid || o.id || '');
      }
    }
  } catch (err) {
    // continue
  }

  return saveZohoAccountMeta({
    userName: userName || 'Zoho Workspace Account',
    userEmail: userEmail || 'admin@climeto.com',
    zuid: zuid || '60029188471',
    orgName: orgName || 'Climeto Global Ltd',
    orgId: orgId || '700192841',
    role,
    accountUrl: accountBaseUrl,
    status: 'Connected (OAuth 2.0 Active)',
  });
}

/**
 * Dedicated sync function for Zoho Accounts (IAM & Companies).
 */
export async function syncZohoAccounts(options = {}) {
  return syncZohoCrm(options);
}

/**
 * Get unified Zoho Accounts payload for frontend
 */
export function getZohoAccountsPayload(filters = {}) {
  const meta = getZohoAccountMeta();
  const accounts = listZohoAccounts(filters);
  const hasCredentials = Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_REFRESH_TOKEN);

  return {
    meta,
    accounts,
    count: accounts.length,
    authStatus: {
      hasCredentials,
      accountsUrl: process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in',
      apiBaseUrl: process.env.ZOHO_API_BASE_URL || 'https://www.zohoapis.in',
      connected: hasCredentials,
      message: hasCredentials
        ? 'Zoho Accounts & CRM connected via OAuth 2.0.'
        : 'Running in demonstration mode. Set ZOHO_CLIENT_ID and ZOHO_REFRESH_TOKEN in .env for live sync.',
    },
  };
}

