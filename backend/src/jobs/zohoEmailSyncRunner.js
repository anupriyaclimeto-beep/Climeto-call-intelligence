import dotenv from 'dotenv';
import { initializeDb } from '../db.js';
import { syncZohoEmails } from '../services/zohoEmailSync.js';

dotenv.config();

async function main() {
  await initializeDb();
  console.log('[Zoho Email Sync] Running on-demand executive email sync...');
  const result = await syncZohoEmails();
  console.log('[Zoho Email Sync] Result:', result);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[Zoho Email Sync] Fatal error:', err);
  process.exit(1);
});
