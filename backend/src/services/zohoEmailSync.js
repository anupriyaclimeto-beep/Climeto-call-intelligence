import dotenv from 'dotenv';
import { getZohoAccessToken } from './zohoSync.js';
import {
  all,
  getZohoEmailsStats,
  listZohoEmails,
  persistDb,
  upsertZohoEmail,
} from '../db.js';

dotenv.config();

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
 * Syncs emails across all executives from Zoho CRM.
 */
export async function syncZohoEmails(options = {}) {
  const clientId = options.clientId || process.env.ZOHO_CLIENT_ID || '';
  const clientSecret = options.clientSecret || process.env.ZOHO_CLIENT_SECRET || '';
  const refreshToken = options.refreshToken || process.env.ZOHO_REFRESH_TOKEN || '';

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

    // 1. Fetch leads from local database to check their Zoho email threads
    const leadsList = all('SELECT id, client_name, email FROM leads LIMIT 30');

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

    persistDb();

    return {
      ok: true,
      processed: totalProcessed,
      inserted: totalInserted,
      updated: totalUpdated,
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
  const hasCredentials = Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_REFRESH_TOKEN);

  return {
    emails,
    stats,
    hasCredentials,
    authStatus: {
      connected: hasCredentials,
      mode: hasCredentials ? 'live-zoho-oauth' : 'seeded-demonstration',
      message: hasCredentials
        ? 'Zoho Executive Emails are live-synced via OAuth 2.0.'
        : 'Displaying executive email history. Provide Zoho API keys in .env for live CRM email syncing.',
    },
  };
}
