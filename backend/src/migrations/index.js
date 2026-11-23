import { id as migration001Id, up as migration001Up } from './001_campaign_events.js';
import { id as migration002Id, up as migration002Up } from './002_zoho_accounts.js';
import { id as migration003Id, up as migration003Up } from './003_zoho_emails.js';
import { id as migration004Id, up as migration004Up } from './004_whatsapp_messages.js';
import { id as migration005Id, up as migration005Up } from './005_pitch_training.js';
import { id as migration006Id, up as migration006Up } from './006_knowledge_docs.js';

const migrations = [
  { id: migration001Id, up: migration001Up },
  { id: migration002Id, up: migration002Up },
  { id: migration003Id, up: migration003Up },
  { id: migration004Id, up: migration004Up },
  { id: migration005Id, up: migration005Up },
  { id: migration006Id, up: migration006Up },
];

function all(db, query, params = []) {
  const statement = db.prepare(query);
  statement.bind(params);
  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();
  return rows;
}

/**
 * Run pending migrations once on boot. Existing data is preserved.
 */
export function runMigrations(db, { persist } = {}) {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    all(db, 'SELECT id FROM schema_migrations').map((row) => row.id),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    migration.up(db);
    db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
      migration.id,
      new Date().toISOString(),
    ]);
  }

  if (typeof persist === 'function') persist();
}
