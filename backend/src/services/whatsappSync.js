import {
  getWhatsAppStats,
  listLeads,
  listWhatsAppMessages,
  upsertWhatsAppMessage,
} from '../db.js';

/**
 * Handles incoming WhatsApp sync payload from Android companion app
 */
export function receiveWhatsAppSync(payload = {}) {
  const phone = payload.clientPhone || payload.client_phone || '';
  const message = payload.message || payload.text || payload.body || '';

  if (!phone || !String(phone).trim()) {
    throw new Error('client_phone is required');
  }
  if (!message || !String(message).trim()) {
    throw new Error('message content is required');
  }

  const saved = upsertWhatsAppMessage(payload);
  return {
    ok: true,
    message: saved,
  };
}

/**
 * Returns structured feed payload for the frontend WhatsApp tab
 */
export function getWhatsAppFeedPayload(filters = {}) {
  const messages = listWhatsAppMessages(filters);
  const stats = getWhatsAppStats();

  return {
    messages,
    stats,
    activeFilters: filters,
  };
}

/**
 * Simulates a realistic WhatsApp interaction from an executive Android phone for testing
 */
export function simulateWhatsAppMessage(overrides = {}) {
  const leads = listLeads();
  const targetLead = (leads && leads.length > 0) ? leads[Math.floor(Math.random() * leads.length)] : null;

  const defaultTemplates = [
    {
      direction: 'incoming',
      text: 'Quotation mil gaya hai. CPCB credits ka per MT rate finalize karne ke liye call arrange karein.',
    },
    {
      direction: 'outgoing',
      text: 'Ji sir, maine draft agreement aur audit checklist WhatsApp pe bhej diya hai.',
    },
    {
      direction: 'incoming',
      text: 'Hamari manufacturing plant inspection next Tuesday planned hai, team ready rakhiye.',
    },
  ];

  const pick = defaultTemplates[Math.floor(Math.random() * defaultTemplates.length)];
  const suffix = String(Date.now()).slice(-4);

  const payload = {
    externalId: overrides.externalId || `sim-wa-${suffix}`,
    deviceId: overrides.deviceId || 'd-ambuj-1',
    leadId: overrides.leadId || targetLead?.id || 'lead-1',
    executiveName: overrides.executiveName || 'Ambuj Pathak',
    clientName: overrides.clientName || targetLead?.client_name || 'Simulated Lead',
    clientPhone: overrides.clientPhone || targetLead?.client_phone || '+919999999999',
    direction: overrides.direction || pick.direction,
    message: overrides.message || pick.text,
    timestamp: new Date().toISOString(),
    status: 'received',
  };

  const saved = upsertWhatsAppMessage(payload);
  return saved;
}

