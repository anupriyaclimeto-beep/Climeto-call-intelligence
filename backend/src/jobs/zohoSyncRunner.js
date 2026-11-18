import { syncZohoCrm } from '../services/zohoSync.js';
import { initializeDb } from '../db.js';

await initializeDb();
const result = await syncZohoCrm();
console.log('Zoho Sync Result:', JSON.stringify(result, null, 2));
