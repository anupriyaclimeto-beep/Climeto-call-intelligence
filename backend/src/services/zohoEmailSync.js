import dotenv from 'dotenv';
import { getZohoAccessToken } from './zohoSync.js';
import {
  all,
  getZohoEmailSettings,
  getZohoEmailsStats,
  listZohoEmails,
  persistDb,
  purgeSeededZohoEmails,
  upsertZohoEmail,
} from '../db.js';

dotenv.config();

let cachedMailToken = null;
let mailTokenExpiresAt = 0;

function decodeHtmlEntities(raw = '') {
  return String(raw || '')
    .replace(/&(nbsp|zwnj|zwj|shy|#160|#8203|#8204|#8205);/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCleanEmail(raw = '') {
  const decoded = decodeHtmlEntities(raw);
  const angleMatch = decoded.match(/<([^>\s]+@[^>\s]+)>/);
  if (angleMatch) return angleMatch[1].trim().toLowerCase();
  const plainMatch = decoded.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  return plainMatch ? plainMatch[1].trim().toLowerCase() : decoded.toLowerCase();
}

function toIsoTimestamp(raw) {
  if (!raw) return new Date().toISOString();
  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && asNum > 100000000000) {
    return new Date(asNum).toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export async function getZohoMailAccessToken(options = {}) {
  const now = Date.now();
  if (cachedMailToken && now < mailTokenExpiresAt - 60000 && !options.forceRefresh) {
    return cachedMailToken;
  }

  const clientId = options.clientId || process.env.ZOHO_MAIL_CLIENT_ID || process.env.ZOHO_CLIENT_ID || '';
  const clientSecret =
    options.clientSecret || process.env.ZOHO_MAIL_CLIENT_SECRET || process.env.ZOHO_CLIENT_SECRET || '';
  const refreshToken = options.refreshToken || process.env.ZOHO_MAIL_REFRESH_TOKEN || '';
  const accountsUrl = (
    options.accountsUrl ||
    process.env.ZOHO_ACCOUNTS_URL ||
    'https://accounts.zoho.in'
  ).replace(/\/+$/, '');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Zoho Mail OAuth credentials missing (ZOHO_MAIL_REFRESH_TOKEN).');
  }

  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Zoho Mail token error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (data.error || !data.access_token) {
    throw new Error(`Zoho Mail OAuth error: ${data.error || 'No access token returned'}`);
  }

  cachedMailToken = data.access_token;
  mailTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedMailToken;
}

/**
 * Normalizes email item from Zoho CRM or Zoho Mail API
 */
export function normalizeZohoEmailItem(item, context = {}) {
  const fromEmail = String(item.from?.email || item.from_email || item.from || '').toLowerCase();
  const toEmail = String(
    Array.isArray(item.to) ? item.to[0]?.email : item.to?.email || item.to_email || item.to || '',
  ).toLowerCase();

  // If fromEmail matches our domain or executive context, it is outbound; else inbound
  const isExecutiveSender =
    fromEmail.includes('@climeto.com') ||
    Boolean(context.executiveEmail && fromEmail === context.executiveEmail);

  const direction = isExecutiveSender ? 'outbound' : 'inbound';
  const executiveEmail = isExecutiveSender ? fromEmail : toEmail;
  const executiveName =
    (isExecutiveSender ? item.from?.name || item.from_name : item.to?.[0]?.name || item.to_name) ||
    context.executiveName ||
    'Zoho Executive';

  const clientEmail = isExecutiveSender ? toEmail : fromEmail;
  const clientName =
    (!isExecutiveSender ? item.from?.name || item.from_name : item.to?.[0]?.name || item.to_name) ||
    context.clientName ||
    'Client';

  const subject = item.subject || item.Subject || 'No Subject';
  const summary = item.summary || item.snippet || item.content?.slice(0, 150) || '';
  const bodySnippet = item.content || item.body || summary;
  const sentAt = item.sent_time || item.sent_at || item.time || new Date().toISOString();
  const status = item.status || (direction === 'inbound' ? 'received' : 'sent');
  const externalId = String(item.message_id || item.id || `${fromEmail}-${sentAt}`);
  const zohoUrl = item.zoho_url || `https://crm.zoho.in/crm/tab/Emails/${externalId}`;

  return {
    externalId,
    leadId: context.leadId || null,
    executiveName,
    executiveEmail,
    clientName,
    clientEmail,
    direction,
    subject,
    summary,
    bodySnippet,
    sentAt,
    status,
    zohoUrl,
  };
}

/**
 * Syncs real Sent + Received emails from Zoho Mail API (Organization + connected mailbox).
 */
async function syncFromZohoMailApi(options = {}) {
  const refreshToken = options.mailRefreshToken || process.env.ZOHO_MAIL_REFRESH_TOKEN || '';
  if (!refreshToken) {
    return { enabled: false, processed: 0, inserted: 0, updated: 0 };
  }

  const mailBaseUrl = (process.env.ZOHO_MAIL_BASE_URL || 'https://mail.zoho.in').replace(/\/+$/, '');
  const accessToken = await getZohoMailAccessToken(options);
  const headers = {
    Authorization: `Zoho-oauthtoken ${accessToken}`,
    Accept: 'application/json',
  };

  // 1. Discover authenticated Zoho Mail account + organization ID
  const acctRes = await fetch(`${mailBaseUrl}/api/accounts`, { headers });
  if (!acctRes.ok) {
    const text = await acctRes.text().catch(() => '');
    throw new Error(`Zoho Mail /api/accounts failed (${acctRes.status}): ${text.slice(0, 200)}`);
  }
  const acctJson = await acctRes.json();
  const primaryAccounts = Array.isArray(acctJson.data) ? acctJson.data : [];
  if (!primaryAccounts.length) {
    return { enabled: true, processed: 0, inserted: 0, updated: 0 };
  }

  // 2. Build 36-user organization executive directory map (email -> displayName)
  const orgDirectory = new Map();
  const zoid = primaryAccounts[0]?.policyId?.zoid || primaryAccounts[0]?.zoid || null;
  if (zoid) {
    try {
      const orgRes = await fetch(`${mailBaseUrl}/api/organization/${zoid}/accounts?limit=100`, { headers });
      if (orgRes.ok) {
        const orgJson = await orgRes.json();
        for (const u of Array.isArray(orgJson.data) ? orgJson.data : []) {
          const em = String(u.primaryEmailAddress || '').trim().toLowerCase();
          if (em) orgDirectory.set(em, String(u.displayName || u.firstName || em).trim());
        }
      }
    } catch (orgErr) {
      console.warn('[Zoho Mail Sync] Org directory notice:', orgErr.message);
    }
  }

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  const seenMsgIds = new Set();

  for (const acct of primaryAccounts) {
    const accountId = acct.accountId;
    const acctEmail = String(acct.primaryEmailAddress || '').trim().toLowerCase();
    const acctName = String(acct.displayName || orgDirectory.get(acctEmail) || acctEmail).trim();
    if (!accountId) continue;

    // Pull both Inbox/Received AND Sent messages
    const fetches = [
      fetch(`${mailBaseUrl}/api/accounts/${accountId}/messages/view?limit=35&includeto=true`, { headers })
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .catch(() => ({ data: [] })),
      acctEmail
        ? fetch(
            `${mailBaseUrl}/api/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(`sender:${acctEmail}`)}&limit=35`,
            { headers },
          )
            .then((r) => (r.ok ? r.json() : { data: [] }))
            .catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] }),
    ];

    const [inboxJson, sentJson] = await Promise.all(fetches);
    const combined = [
      ...(Array.isArray(inboxJson?.data) ? inboxJson.data : []),
      ...(Array.isArray(sentJson?.data) ? sentJson.data : []),
    ];

    const { trackedEmails, hideAutomated } = getZohoEmailSettings();
    const trackedSet = new Set(trackedEmails);
    const isAutomatedAddress = (addr = '') =>
      /noreply|no-reply|donotreply|mailer-daemon|zohocalendar|zohoaccounts|notifications@/i.test(addr);

    for (const msg of combined) {
      const msgId = String(msg.messageId || '').trim();
      if (!msgId || seenMsgIds.has(msgId)) continue;
      seenMsgIds.add(msgId);

      const fromEmail = extractCleanEmail(msg.fromAddress || '');
      const toEmail = extractCleanEmail(msg.toAddress || '');
      const ccEmail = extractCleanEmail(msg.ccAddress || '');
      const fromIsClimeto = fromEmail.endsWith('@climeto.com');
      const toIsClimeto = toEmail.endsWith('@climeto.com');

      const direction = fromIsClimeto && !toIsClimeto
        ? 'outbound'
        : fromEmail === acctEmail
          ? 'outbound'
          : 'inbound';

      let executiveEmail = direction === 'outbound'
        ? (fromIsClimeto ? fromEmail : acctEmail)
        : (toIsClimeto ? toEmail : acctEmail);

      // If tracked executive emails are configured, match against from/to/cc and skip non-tracked mailboxes
      if (trackedSet.size > 0) {
        const matchedTracked = [fromEmail, toEmail, ccEmail].find((e) => trackedSet.has(e));
        if (!matchedTracked) continue;
        executiveEmail = matchedTracked;
      }

      const executiveName = orgDirectory.get(executiveEmail) || acctName || 'Climeto Executive';

      const clientEmail = direction === 'outbound' ? toEmail : fromEmail;
      if (hideAutomated && isAutomatedAddress(clientEmail)) continue;
      const rawClientName = direction === 'outbound'
        ? decodeHtmlEntities(msg.toAddress || '').replace(/<[^>]+>/g, '').trim()
        : decodeHtmlEntities(msg.sender || '').trim();
      const clientName = rawClientName && rawClientName !== clientEmail
        ? rawClientName
        : clientEmail || 'Client';

      const subject = decodeHtmlEntities(msg.subject || 'No Subject');
      const summary = decodeHtmlEntities(msg.summary || '').slice(0, 240);
      const sentAt = toIsoTimestamp(msg.receivedTime || msg.sentDateInGMT);
      const zohoUrl = msg.folderId
        ? `${mailBaseUrl}/zm/#mail/folder/${msg.folderId}/p/${msgId}`
        : `${mailBaseUrl}/zm/`;

      const res = upsertZohoEmail({
        externalId: `zmail-${msgId}`,
        executiveName,
        executiveEmail,
        clientName,
        clientEmail,
        direction,
        subject,
        summary,
        bodySnippet: summary,
        sentAt,
        status: direction === 'outbound' ? 'sent' : 'received',
        zohoUrl,
      });

      processed += 1;
      if (res.inserted) inserted += 1;
      if (res.updated) updated += 1;
    }
  }

  return { enabled: true, processed, inserted, updated, orgUsers: orgDirectory.size };
}

/**
 * Syncs emails across all executives from Zoho Mail API + Zoho CRM.
 */
export async function syncZohoEmails(options = {}) {
  const hasMailAuth = Boolean(options.mailRefreshToken || process.env.ZOHO_MAIL_REFRESH_TOKEN);
  const clientId = options.clientId || process.env.ZOHO_CLIENT_ID || '';
  const clientSecret = options.clientSecret || process.env.ZOHO_CLIENT_SECRET || '';
  const refreshToken = options.refreshToken || process.env.ZOHO_REFRESH_TOKEN || '';
  const hasCrmAuth = Boolean(clientId && clientSecret && refreshToken);

  if (!hasMailAuth && !hasCrmAuth) {
    return {
      ok: false,
      skipped: true,
      message: 'Zoho credentials not configured. Set ZOHO_MAIL_REFRESH_TOKEN or ZOHO_REFRESH_TOKEN in .env.',
    };
  }

  let totalProcessed = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let mailSummary = null;

  try {
    // 1. Primary: Zoho Mail API (Inbox Received + Sent)
    if (hasMailAuth) {
      try {
        mailSummary = await syncFromZohoMailApi(options);
        totalProcessed += mailSummary.processed;
        totalInserted += mailSummary.inserted;
        totalUpdated += mailSummary.updated;
      } catch (mailErr) {
        console.warn('[Zoho Mail Sync] Notice:', mailErr.message);
      }
    }

    // 2. Secondary: Zoho CRM Lead-linked Emails
    if (hasCrmAuth) {
      try {
        const { accessToken, apiDomain } = await getZohoAccessToken(options);
        const leadsList = all(
          "SELECT id, client_name, email FROM leads WHERE id LIKE 'zoho-lead-%' ORDER BY rowid DESC LIMIT 50",
        );

        for (const lead of leadsList) {
          if (!lead.id.startsWith('zoho-lead-')) continue;
          const rawZohoId = lead.id.replace('zoho-lead-', '');

          try {
            const url = `${apiDomain.replace(/\/+$/, '')}/crm/v2/Leads/${rawZohoId}/Emails`;
            const res = await fetch(url, {
              headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
                Accept: 'application/json',
              },
            });

            if (res.status === 204 || !res.ok) continue;

            const json = await res.json();
            const emailItems = Array.isArray(json.email_related_list)
              ? json.email_related_list
              : Array.isArray(json.Emails)
                ? json.Emails
                : Array.isArray(json.data)
                  ? json.data
                  : [];

            for (const item of emailItems) {
              totalProcessed++;
              const normalized = normalizeZohoEmailItem(item, {
                leadId: lead.id,
                clientName: lead.client_name,
                clientEmail: lead.email,
              });

              const result = upsertZohoEmail(normalized);
              if (result.inserted) totalInserted++;
              if (result.updated) totalUpdated++;
            }
          } catch (leadEmailErr) {
            console.warn(`[Zoho Email Sync] Notice fetching emails for lead ${rawZohoId}:`, leadEmailErr.message);
          }
        }
      } catch (crmErr) {
        console.warn('[Zoho CRM Email Sync] Notice:', crmErr.message);
      }
    }

    // Once real emails are synced, remove the 6 demo seed emails so only real data shows
    if (totalProcessed > 0) {
      purgeSeededZohoEmails();
    } else {
      persistDb();
    }

    return {
      ok: true,
      processed: totalProcessed,
      inserted: totalInserted,
      updated: totalUpdated,
      orgUsers: mailSummary?.orgUsers ?? 0,
      syncedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[Zoho Email Sync] Error:', err.message);
    return {
      ok: false,
      error: err.message || String(err),
    };
  }
}

/**
 * Handle real-time incoming webhook from Zoho (Workflow Rule / Zoho Mail Notification)
 */
export function receiveZohoEmailWebhook(payload = {}) {
  const emailData = payload.data || payload.email || payload;
  if (!emailData) {
    throw new Error('Invalid email payload');
  }

  const normalized = normalizeZohoEmailItem(emailData);
  const result = upsertZohoEmail(normalized);
  persistDb();

  return {
    success: true,
    action: result.inserted ? 'inserted' : 'updated',
    id: result.id,
  };
}

/**
 * Returns formatted payload for frontend Email Page
 */
export function getZohoEmailsPayload(filters = {}) {
  const emails = listZohoEmails(filters);
  const stats = getZohoEmailsStats();
  const hasMailToken = Boolean(process.env.ZOHO_MAIL_REFRESH_TOKEN);
  const hasCredentials = hasMailToken || Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_REFRESH_TOKEN);

  return {
    emails,
    stats,
    settings: getZohoEmailSettings(),
    hasCredentials,
    authStatus: {
      connected: hasCredentials,
      mode: hasMailToken ? 'live-zoho-mail' : hasCredentials ? 'live-zoho-oauth' : 'seeded-demonstration',
      message: hasMailToken
        ? 'Zoho Mail (Inbox + Sent) is live-synced via OAuth 2.0.'
        : hasCredentials
          ? 'Zoho Executive Emails are live-synced via OAuth 2.0.'
          : 'Displaying executive email history. Provide Zoho API keys in .env for live email syncing.',
    },
  };
}
