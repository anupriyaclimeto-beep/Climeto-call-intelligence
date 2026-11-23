import crypto from 'crypto';

const EVENT_ALIASES = {
  sent: 'sent',
  send: 'sent',
  delivered: 'sent',
  delivery: 'sent',
  email_sent: 'sent',
  message_sent: 'sent',

  open: 'opened',
  opened: 'opened',
  email_open: 'opened',
  email_opened: 'opened',
  message_opened: 'opened',

  click: 'clicked',
  clicked: 'clicked',
  email_click: 'clicked',
  email_clicked: 'clicked',
  link_clicked: 'clicked',

  reply: 'replied',
  replied: 'replied',
  email_reply: 'replied',
  email_replied: 'replied',
  response: 'replied',

  bounce: 'bounced',
  bounced: 'bounced',
  soft_bounce: 'bounced',
  hard_bounce: 'bounced',
  email_bounced: 'bounced',
};

const TITLE_BY_TYPE = {
  sent: 'Email sent',
  opened: 'Email opened',
  clicked: 'Link clicked',
  replied: 'Reply received',
  bounced: 'Email bounced',
};

function firstDefined(obj, keys) {
  for (const key of keys) {
    if (!obj || typeof obj !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null && obj[key] !== '') {
      return obj[key];
    }
  }
  return undefined;
}

function dig(payload, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let cur = payload;
    let ok = true;
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object' || !(part in cur)) {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    if (ok && cur != null && cur !== '') return cur;
  }
  return undefined;
}

function asObject(payload) {
  if (payload == null) return {};
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      return { raw: payload };
    }
  }
  if (typeof payload === 'object') return payload;
  return { value: payload };
}

function normalizeEventType(raw) {
  if (raw == null) return null;
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return EVENT_ALIASES[key] || null;
}

function normalizeEmail(value) {
  if (value == null) return null;
  const email = String(value).trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  return email;
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return new Date().toISOString();

  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function buildTitle(eventType, campaignName, clickUrl) {
  if (eventType === 'clicked') {
    if (campaignName) return `${campaignName} link clicked`;
    if (clickUrl) return 'Pricing brochure clicked';
    return TITLE_BY_TYPE.clicked;
  }
  return TITLE_BY_TYPE[eventType] || 'Campaign event';
}

function buildDescription({ eventType, campaignName, leadEmail, clickUrl, subject }) {
  const parts = [];

  if (eventType === 'replied') {
    parts.push('The lead replied to the email.');
  } else if (eventType === 'opened') {
    parts.push('The lead opened the campaign email.');
  } else if (eventType === 'clicked') {
    parts.push('The lead clicked the campaign link.');
  } else if (eventType === 'sent') {
    parts.push('The campaign email was sent successfully.');
  } else if (eventType === 'bounced') {
    parts.push('The email bounced.');
  } else {
    parts.push('Campaign activity received.');
  }

  if (campaignName) parts.push(`Campaign: ${campaignName}.`);
  if (subject) parts.push(`Subject: ${subject}.`);
  if (leadEmail) parts.push(`Email: ${leadEmail}.`);
  if (clickUrl) parts.push(`Clicked URL: ${clickUrl}`);

  return parts.join(' ');
}

function hashExternalId(email, eventType, occurredAt) {
  const basis = `${email || ''}|${eventType || ''}|${occurredAt || ''}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/**
 * Defensive Manyreach payload normalizer.
 * Field names are not guaranteed — try several common shapes.
 */
export function normalizeManyreachEvent(rawPayload) {
  const root = asObject(rawPayload);
  const data = asObject(
    firstDefined(root, ['data', 'event', 'payload', 'body', 'record']) ?? root,
  );
  const nested = asObject(
    firstDefined(data, ['contact', 'lead', 'recipient', 'subscriber', 'user']) ?? {},
  );

  const eventType = normalizeEventType(
    firstDefined(root, ['event_type', 'eventType', 'type', 'event', 'action', 'name', 'status'])
      ?? firstDefined(data, ['event_type', 'eventType', 'type', 'event', 'action', 'name', 'status'])
      ?? dig(root, ['event.type', 'data.type', 'data.event_type']),
  );

  const leadEmail = normalizeEmail(
    firstDefined(root, ['email', 'lead_email', 'recipient_email', 'to', 'to_email', 'contact_email'])
      ?? firstDefined(data, ['email', 'lead_email', 'recipient_email', 'to', 'to_email', 'contact_email'])
      ?? firstDefined(nested, ['email', 'Email', 'mail'])
      ?? dig(root, ['data.email', 'contact.email', 'recipient.email', 'lead.email']),
  );

  const leadName = (() => {
    const direct = firstDefined(root, ['lead_name', 'name', 'contact_name', 'recipient_name', 'full_name'])
      ?? firstDefined(data, ['lead_name', 'name', 'contact_name', 'recipient_name', 'full_name'])
      ?? firstDefined(nested, ['name', 'full_name', 'Name']);
    if (direct) return String(direct).trim();
    const first = firstDefined(nested, ['first_name', 'firstName']) || '';
    const last = firstDefined(nested, ['last_name', 'lastName']) || '';
    const combined = `${first} ${last}`.trim();
    return combined || null;
  })();

  const leadPhone = firstDefined(root, ['phone', 'lead_phone', 'mobile', 'phone_number'])
    ?? firstDefined(data, ['phone', 'lead_phone', 'mobile', 'phone_number'])
    ?? firstDefined(nested, ['phone', 'mobile', 'phone_number'])
    ?? null;

  const campaignName = (() => {
    const value = firstDefined(root, ['campaign_name', 'campaign', 'campaignName', 'sequence_name', 'list_name'])
      ?? firstDefined(data, ['campaign_name', 'campaign', 'campaignName', 'sequence_name', 'list_name'])
      ?? dig(root, ['campaign.name', 'data.campaign.name', 'data.campaign_name']);
    if (value == null) return null;
    if (typeof value === 'object') {
      return String(value.name || value.title || value.id || '').trim() || null;
    }
    return String(value).trim() || null;
  })();

  const clickUrl = firstDefined(root, ['url', 'link', 'clicked_url', 'click_url', 'href'])
    ?? firstDefined(data, ['url', 'link', 'clicked_url', 'click_url', 'href'])
    ?? dig(root, ['data.url', 'click.url', 'link.url'])
    ?? null;

  const subject = firstDefined(root, ['subject', 'email_subject'])
    ?? firstDefined(data, ['subject', 'email_subject'])
    ?? null;

  const occurredAt = normalizeTimestamp(
    firstDefined(root, [
      'occurred_at',
      'occurredAt',
      'timestamp',
      'time',
      'created_at',
      'createdAt',
      'event_time',
      'sent_at',
      'opened_at',
      'clicked_at',
      'replied_at',
      'bounced_at',
    ])
      ?? firstDefined(data, [
        'occurred_at',
        'occurredAt',
        'timestamp',
        'time',
        'created_at',
        'createdAt',
        'event_time',
        'sent_at',
        'opened_at',
        'clicked_at',
        'replied_at',
        'bounced_at',
      ]),
  );

  const externalCandidate = firstDefined(root, [
    'id',
    'event_id',
    'eventId',
    'uuid',
    'message_id',
    'messageId',
    'external_id',
  ])
    ?? firstDefined(data, [
      'id',
      'event_id',
      'eventId',
      'uuid',
      'message_id',
      'messageId',
      'external_id',
    ]);

  const externalId = externalCandidate
    ? String(externalCandidate)
    : hashExternalId(leadEmail, eventType, occurredAt);

  if (!eventType) {
    return {
      ok: false,
      error: 'Unable to normalize event_type from payload',
      externalId,
      raw: root,
    };
  }

  const title = buildTitle(eventType, campaignName, clickUrl ? String(clickUrl) : null);
  const description = buildDescription({
    eventType,
    campaignName,
    leadEmail,
    clickUrl: clickUrl ? String(clickUrl) : null,
    subject: subject ? String(subject) : null,
  });

  return {
    ok: true,
    externalId,
    channel: 'email',
    source: 'manyreach',
    leadEmail,
    leadName,
    leadPhone: leadPhone != null ? String(leadPhone) : null,
    campaignName,
    eventType,
    title,
    description,
    occurredAt,
    clickUrl: clickUrl ? String(clickUrl) : null,
    isSeeded: 0,
  };
}

export { normalizeEventType, normalizeEmail, hashExternalId };
