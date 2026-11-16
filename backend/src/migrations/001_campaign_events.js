/**
 * Migration 001: Manyreach webhook + campaign events tables.
 * Safe for existing DBs — CREATE IF NOT EXISTS only (no data deletes).
 */
export const id = '001_campaign_events';

export function up(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS campaign_events (
      id TEXT PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL DEFAULT 'email',
      source TEXT NOT NULL DEFAULT 'manyreach',
      lead_id TEXT,
      lead_name TEXT,
      lead_email TEXT,
      lead_phone TEXT,
      campaign_name TEXT,
      event_type TEXT NOT NULL,
      title TEXT,
      description TEXT,
      occurred_at TEXT NOT NULL,
      is_seeded INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_campaign_events_occurred_at
      ON campaign_events(occurred_at DESC);

    CREATE INDEX IF NOT EXISTS idx_campaign_events_lead_id
      ON campaign_events(lead_id);

    CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
      ON webhook_events(received_at DESC);
  `);
}
