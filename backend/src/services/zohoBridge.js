export function getZohoSettings(env = process.env) {
  const baseUrl = env.ZOHO_CRM_BASE_URL || '';
  const template = env.ZOHO_LEADS_URL_TEMPLATE || '';

  return {
    connected: Boolean(baseUrl || template),
    mode: template ? 'template' : baseUrl ? 'base-url' : 'pending',
    baseUrl,
    template,
    message:
      template || baseUrl
        ? 'Zoho navigation can be enabled from configured URLs.'
        : 'Set ZOHO_CRM_BASE_URL or ZOHO_LEADS_URL_TEMPLATE later to enable direct navigation.',
  };
}

export function buildZohoLeadUrl(lead, env = process.env) {
  const settings = getZohoSettings(env);

  if (lead?.zoho_url) return lead.zoho_url;
  if (settings.template) {
    return settings.template
      .replaceAll('{leadId}', lead?.id || '')
      .replaceAll('{phone}', lead?.client_phone || '');
  }

  return settings.baseUrl || '';
}
