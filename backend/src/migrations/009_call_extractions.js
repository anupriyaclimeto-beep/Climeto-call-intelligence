/**
 * Migration 009: Evidence-Backed Call Extractions
 * 
 * Stores per-field sales intelligence extracted from calls with exact quotes,
 * timestamps, confidence scores, and manual review flags.
 */
export const id = '009_call_extractions';

export function up(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS call_extractions (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      value TEXT,
      evidence TEXT,
      timestamp TEXT,
      confidence REAL NOT NULL DEFAULT 0.0,
      needs_review INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'call_ai',
      model TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ce_call_id ON call_extractions(call_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ce_call_field ON call_extractions(call_id, field_name);
  `);
}
