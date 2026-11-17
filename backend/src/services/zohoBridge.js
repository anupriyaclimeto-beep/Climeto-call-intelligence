export function getZohoSettings(env = process.env) {
  const baseUrl = env.ZOHO_CRM_BASE_URL || '';
  const template = env.ZOHO_LEADS_URL_TEMPLATE || '';
  const hasCredentials = Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_REFRESH_TOKEN);

  return {
    connected: Boolean(baseUrl || template || hasCredentials),
    mode: hasCredentials ? 'full-api-sync' : template ? 'template' : baseUrl ? 'base-url' : 'pending',
    baseUrl,
    template,
    hasCredentials,
    message: hasCredentials
      ? 'Zoho CRM API Auto-Sync is configured and active.'
      : template || baseUrl
      ? 'Zoho navigation is active. Add ZOHO_CLIENT_ID & ZOHO_REFRESH_TOKEN to enable automatic data sync.'
      : 'Set ZOHO_CRM_BASE_URL, ZOHO_LEADS_URL_TEMPLATE, or Zoho API keys to connect.',
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
