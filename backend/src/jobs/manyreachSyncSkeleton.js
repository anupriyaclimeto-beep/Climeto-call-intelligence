import crypto from 'crypto';
import dotenv from 'dotenv';
import {
  findLeadByEmail,
  insertCampaignEvent,
  persistDb,
} from '../db.js';
import { toE164India } from '../services/phoneFormat.js';

dotenv.config();

function extractEmailAndName(raw) {
  if (!raw) return { email: null, name: null };
  const str = String(raw).trim();
  const match = str.match(/(?:["']?([^"']*)["']?\s*)?<([^>]+)>/);
  if (match) {
    const name = (match[1] || '').trim();
    const email = (match[2] || '').trim().toLowerCase();
    return { email, name: name || null };
  }
  const cleanEmail = str.toLowerCase();
  return {
    email: cleanEmail,
    name: cleanEmail.split('@')[0],
  };
}

function cleanBody(rawBody) {
  if (!rawBody) return '';
  return String(rawBody)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export async function syncManyreachEvents(options = {}) {
  const enabled =
    options.enabled ??
    String(process.env.MANYREACH_SYNC_ENABLED || 'false').toLowerCase() === 'true';
  const apiKey = options.apiKey || process.env.MANYREACH_API_KEY || '';
  const baseUrl = options.baseUrl || process.env.MANYREACH_API_BASE_URL || 'https://api.manyreach.com';

  if (!enabled) {
    return {
      ok: false,
      skipped: true,
      message: 'MANYREACH_SYNC_ENABLED is false — set to true in .env to enable Manyreach sync.',
    };
  }

  if (!apiKey) {
    return {
      ok: false,
      skipped: true,
      message: 'MANYREACH_API_KEY missing — cannot sync.',
    };
  }

  async function apiRequest(path) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Manyreach API error ${res.status}: ${text || res.statusText}`);
    }
    return res.json();
  }

  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalProcessed = 0;

  try {
    // 1. Fetch campaigns for name lookup
    const campaignMap = new Map();
    let campaigns = [];
    try {
      const campaignsRes = await apiRequest('/api/v2/campaigns');
      campaigns = Array.isArray(campaignsRes.items) ? campaignsRes.items : [];
      for (const c of campaigns) {
        campaignMap.set(c.campaignId, c.name);
      }
    } catch (err) {
      console.warn('[Manyreach Sync] Could not fetch campaigns:', err.message);
    }

    // 2. Fetch prospects from active campaigns (for bounce/status checks)
    for (const c of campaigns) {
      try {
        const prospectsRes = await apiRequest(`/api/v2/campaigns/${c.campaignId}/prospects`);
        const prospects = Array.isArray(prospectsRes.items) ? prospectsRes.items : [];
        for (const p of prospects) {
          if (p.bounced) {
            const extId = `manyreach-bounce-${p.prospectId}-${c.campaignId}`;
            const lead = p.email ? findLeadByEmail(p.email) : null;
            const res = insertCampaignEvent({
              id: `ce-${crypto.randomUUID()}`,
              externalId: extId,
              channel: 'email',
              source: 'manyreach',
              leadId: lead?.id || null,
              leadName: lead?.client_name || `${p.firstName || ''} ${p.lastName || ''}`.trim() || null,
              leadEmail: p.email,
              leadPhone: lead?.client_phone ? toE164India(lead.client_phone) : null,
              campaignName: c.name,
              eventType: 'bounced',
              title: 'Email bounced',
              description: `Email bounced for ${p.email} in campaign "${c.name}"`,
              occurredAt: p.firstSentAt || p.addedAt || new Date().toISOString(),
              isSeeded: 0,
            });
            if (res.inserted) totalInserted++;
            if (res.duplicate) totalDuplicates++;
            totalProcessed++;
          }
        }
      } catch (err) {
        console.warn(`[Manyreach Sync] Could not fetch prospects for campaign ${c.campaignId}:`, err.message);
      }
    }

    // 3. Fetch messages (Reply, Sent, SentManual)
    const typesToFetch = ['Reply', 'Sent', 'SentManual'];

    for (const type of typesToFetch) {
      let page = 1;
      const maxPages = 5; // pull up to 50 recent messages per type

      while (page <= maxPages) {
        try {
          const res = await apiRequest(`/api/v2/messages?Type=${type}&Page=${page}`);
          const items = Array.isArray(res.items) ? res.items : [];
          if (!items.length) break;

          for (const msg of items) {
            totalProcessed++;
            const isReply = msg.type === 'Reply';
            const rawContact = isReply ? msg.fromEmail : msg.toEmail;
            const { email: leadEmail, name: parsedName } = extractEmailAndName(rawContact);

            const lead = leadEmail ? findLeadByEmail(leadEmail) : null;
            const leadName = lead?.client_name || parsedName || null;
            const leadPhone = lead?.client_phone ? toE164India(lead.client_phone) : null;

            const campaignName =
              campaignMap.get(msg.campaignId) ||
              (msg.campaignId ? `Campaign #${msg.campaignId}` : 'Manyreach Email');

            const eventType = isReply ? 'replied' : 'sent';
            const defaultTitle = isReply ? 'Reply received' : 'Email sent';
            const title = msg.subject ? `${defaultTitle}: ${msg.subject}` : defaultTitle;
            const description = cleanBody(msg.body);
            const occurredAt = msg.createdAt || new Date().toISOString();
            const externalId = `manyreach-msg-${msg.messageId}`;

            const insertResult = insertCampaignEvent({
              id: `ce-${crypto.randomUUID()}`,
              externalId,
              channel: 'email',
              source: 'manyreach',
              leadId: lead?.id || null,
              leadName,
              leadEmail,
              leadPhone,
              campaignName,
              eventType,
              title,
              description,
              occurredAt,
              isSeeded: 0,
            });

            if (insertResult.inserted) totalInserted++;
            if (insertResult.duplicate) totalDuplicates++;
          }

          if (items.length < 10) break; // last page reached
          page++;
        } catch (err) {
          console.warn(`[Manyreach Sync] Error fetching messages for Type=${type} Page=${page}:`, err.message);
          break;
        }
      }
    }

    persistDb();

    return {
      ok: true,
      processed: totalProcessed,
      inserted: totalInserted,
      duplicates: totalDuplicates,
      syncedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[Manyreach Sync] Error during sync:', err);
    return {
      ok: false,
      error: err.message || String(err),
    };
  }
}

async function main() {
  const result = await syncManyreachEvents({ enabled: true });
  console.log('Manyreach Sync Result:', JSON.stringify(result, null, 2));
}

const isDirectRun =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/manyreachSyncSkeleton.js');

if (isDirectRun) {
  import('../db.js')
    .then(async (db) => {
      await db.initializeDb();
      return main();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
