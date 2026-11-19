/**
 * Migration 004: WhatsApp Android Messages table.
 * Stores incoming and outgoing WhatsApp messages synced from sales executives' Android devices.
 */
export const id = '004_whatsapp_messages';

export function up(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY,
      external_id TEXT UNIQUE,
      device_id TEXT,
      lead_id TEXT,
      executive_name TEXT NOT NULL,
      client_name TEXT,
      client_phone TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'incoming',
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT DEFAULT 'received',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_timestamp
      ON whatsapp_messages(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_client_phone
      ON whatsapp_messages(client_phone);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_lead_id
      ON whatsapp_messages(lead_id);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_device_id
      ON whatsapp_messages(device_id);
  `);
}

