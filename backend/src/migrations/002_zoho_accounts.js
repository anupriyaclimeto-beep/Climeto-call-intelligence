/**
 * Migration 002: Zoho Accounts tables.
 * Stores Zoho Accounts IAM profile metadata and Zoho CRM Accounts (companies).
 */
export const id = '002_zoho_accounts';

export function up(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS zoho_accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      phone TEXT,
      website TEXT,
      industry TEXT,
      annual_revenue TEXT,
      billing_city TEXT,
      billing_country TEXT,
      owner_name TEXT,
      zoho_url TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS zoho_account_meta (
      id TEXT PRIMARY KEY,
      user_name TEXT,
      user_email TEXT,
      zuid TEXT,
      org_name TEXT,
      org_id TEXT,
      role TEXT,
      account_url TEXT,
      status TEXT,
      last_synced_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_zoho_accounts_name
      ON zoho_accounts(account_name);
  `);
}
