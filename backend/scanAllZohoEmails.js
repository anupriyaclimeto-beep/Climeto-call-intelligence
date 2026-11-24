import { getZohoAccessToken } from './src/services/zohoSync.js';
import { initializeDb, all } from './src/db.js';

await initializeDb();
const { accessToken, apiDomain } = await getZohoAccessToken();

console.log('--- Step 1: Check Current User and Org details ---');
const userRes = await fetch(`${apiDomain}/crm/v2/users?type=CurrentUser`, {
  headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
});
const userJson = await userRes.json();
console.log('Current User:', userJson.users?.[0]?.full_name, userJson.users?.[0]?.email);

console.log('--- Step 2: Check all active users in Zoho CRM ---');
const allUsersRes = await fetch(`${apiDomain}/crm/v2/users?type=ActiveUsers`, {
  headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
});
const allUsersJson = await allUsersRes.json();
console.log('Active Users:', allUsersJson.users?.map(u => ({ id: u.id, name: u.full_name, email: u.email })));

console.log('--- Step 3: Scan Leads for Emails ---');
const leads = all("SELECT id, client_name, email FROM leads WHERE id LIKE 'zoho-lead-%' AND email != ''");
console.log(`Scanning ${leads.length} leads with email addresses...`);

let foundEmails = [];
for (let i = 0; i < leads.length; i++) {
  const l = leads[i];
  const rawId = l.id.replace('zoho-lead-', '');
  try {
    const res = await fetch(`${apiDomain}/crm/v2/Leads/${rawId}/Emails`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
    });
    if (res.status === 200) {
      const json = await res.json();
      const list = json.email_related_list || json.Emails || json.data || [];
      if (list.length > 0) {
        console.log(`>>> FOUND ${list.length} email(s) on Lead ${rawId} (${l.client_name})!`, list);
        foundEmails.push(...list.map(em => ({ ...em, leadId: l.id, clientName: l.client_name })));
      }
    }
  } catch (e) {
    console.error(`Error on lead ${rawId}:`, e.message);
  }
}
console.log(`Total emails found on Leads: ${foundEmails.length}`);

console.log('--- Step 4: Scan Contacts for Emails ---');
const contacts = all("SELECT id, client_name, email FROM leads WHERE id LIKE 'zoho-contact-%' AND email != ''");
console.log(`Scanning ${contacts.length} contacts with email addresses...`);

for (let i = 0; i < contacts.length; i++) {
  const c = contacts[i];
  const rawId = c.id.replace('zoho-contact-', '');
  try {
    const res = await fetch(`${apiDomain}/crm/v2/Contacts/${rawId}/Emails`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
    });
    if (res.status === 200) {
      const json = await res.json();
      const list = json.email_related_list || json.Emails || json.data || [];
      if (list.length > 0) {
        console.log(`>>> FOUND ${list.length} email(s) on Contact ${rawId} (${c.client_name})!`, list);
        foundEmails.push(...list.map(em => ({ ...em, leadId: c.id, clientName: c.client_name })));
      }
    }
  } catch (e) {
    console.error(`Error on contact ${rawId}:`, e.message);
  }
}
console.log(`Total emails found on Contacts: ${foundEmails.length}`);
