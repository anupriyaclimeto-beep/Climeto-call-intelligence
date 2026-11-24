/**
 * Migration 008: Real Company Dossier and Search History tables.
 * Supports Candidate Disambiguation, Cached Official Section A, and User Search History.
 */
export const id = '008_company_dossier';

export function up(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS company_search_history (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      cin_selected TEXT,
      selected_name TEXT,
      searched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_csh_searched_at ON company_search_history(searched_at DESC);

    CREATE TABLE IF NOT EXISTS company_dossier_cache (
      cin TEXT PRIMARY KEY,
      section_a_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
}
