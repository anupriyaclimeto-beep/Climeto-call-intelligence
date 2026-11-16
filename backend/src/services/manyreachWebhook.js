import crypto from 'crypto';
import {
  findLeadByEmail,
  insertCampaignEvent,
  insertWebhookEvent,
  markWebhookProcessed,
  persistDb,
} from '../db.js';
import { normalizeManyreachEvent } from './manyreachMapper.js';
import { toE164India } from './phoneFormat.js';

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Persist raw webhook first, then normalize + match lead + insert campaign event.
 * Never throws to the caller for processing failures — stores error on webhook_events.
 */
export function receiveManyreachWebhook(rawBody) {
  const webhookId = newId('wh');
  const receivedAt = new Date().toISOString();
  const payloadText = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody ?? {});

  insertWebhookEvent({
    id: webhookId,
    source: 'manyreach',
    payload: payloadText,
    receivedAt,
    processed: 0,
    error: null,
  });
  persistDb();

  try {
    const normalized = normalizeManyreachEvent(
      typeof rawBody === 'string' ? safeParse(rawBody) : rawBody,
    );

    if (!normalized.ok) {
      markWebhookProcessed(webhookId, {
        processed: 0,
        error: normalized.error || 'Normalization failed',
      });
      persistDb();
      return { webhookId, stored: true, inserted: false, reason: normalized.error };
    }

    const lead = normalized.leadEmail ? findLeadByEmail(normalized.leadEmail) : null;
    const leadPhone = lead?.client_phone
      ? toE164India(lead.client_phone)
      : toE164India(normalized.leadPhone);

    const result = insertCampaignEvent({
      id: newId('ce'),
      externalId: normalized.externalId,
      channel: 'email',
      source: 'manyreach',
      leadId: lead?.id || null,
      leadName: lead?.client_name || normalized.leadName || null,
      leadEmail: normalized.leadEmail || lead?.email || null,
      leadPhone,
      campaignName: normalized.campaignName,
      eventType: normalized.eventType,
      title: normalized.title,
      description: normalized.description,
      occurredAt: normalized.occurredAt,
      isSeeded: 0,
    });

    markWebhookProcessed(webhookId, { processed: 1, error: null });
    persistDb();

    return {
      webhookId,
      stored: true,
      inserted: result.inserted,
      duplicate: result.duplicate,
      campaignEventId: result.id,
      leadId: lead?.id || null,
    };
  } catch (err) {
    const message = err?.message || String(err);
    markWebhookProcessed(webhookId, { processed: 0, error: message });
    persistDb();
    return { webhookId, stored: true, inserted: false, reason: message };
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
