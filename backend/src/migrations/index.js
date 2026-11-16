import { id as migration001Id, up as migration001Up } from './001_campaign_events.js';

const migrations = [
  { id: migration001Id, up: migration001Up },
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
