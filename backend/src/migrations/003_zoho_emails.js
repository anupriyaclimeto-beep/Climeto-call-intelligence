/**
 * Migration 003: Zoho Executive Emails table.
 * Stores inbound and outbound emails across all executives, linked to leads.
 */
export const id = '003_zoho_emails';

export function up(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS zoho_emails (
      id TEXT PRIMARY KEY,
      external_id TEXT UNIQUE,
      lead_id TEXT,
      executive_name TEXT NOT NULL,
      executive_email TEXT NOT NULL,
      client_name TEXT,
      client_email TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'outbound',
      subject TEXT NOT NULL,
      summary TEXT,
      body_snippet TEXT,
      sent_at TEXT NOT NULL,
      status TEXT DEFAULT 'delivered',
      zoho_url TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_zoho_emails_sent_at
      ON zoho_emails(sent_at DESC);

    CREATE INDEX IF NOT EXISTS idx_zoho_emails_executive_email
      ON zoho_emails(executive_email);

    CREATE INDEX IF NOT EXISTS idx_zoho_emails_client_email
      ON zoho_emails(client_email);

    CREATE INDEX IF NOT EXISTS idx_zoho_emails_lead_id
      ON zoho_emails(lead_id);
  `);
}
