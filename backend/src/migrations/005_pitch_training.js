/**
 * Migration 005: Pitch Training tables.
 * Stores Climeto Smart Playbook rules, AI + Manager-reviewed pitch evaluations,
 * and interactive AI Roleplay practice sessions.
 */
export const id = '005_pitch_training';

export function up(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS playbook_rules (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      client_cue TEXT,
      ideal_response TEXT NOT NULL,
      priority INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_playbook_category
      ON playbook_rules(category);

    CREATE TABLE IF NOT EXISTS pitch_evaluations (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL DEFAULT 'call',
      target_id TEXT NOT NULL,
      lead_id TEXT,
      executive_name TEXT NOT NULL,
      client_name TEXT,
      channel_summary TEXT,
      overall_score REAL NOT NULL DEFAULT 0,
      scores_json TEXT,
      strengths_json TEXT,
      gaps_json TEXT,
      missed_questions_json TEXT,
      red_flags_json TEXT,
      try_line TEXT,
      ai_summary TEXT,
      model_used TEXT,
      manager_status TEXT NOT NULL DEFAULT 'pending',
      manager_score REAL,
      manager_note TEXT,
      manager_try_line TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(target_type, target_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pitch_eval_exec
      ON pitch_evaluations(executive_name);

    CREATE INDEX IF NOT EXISTS idx_pitch_eval_status
      ON pitch_evaluations(manager_status);

    CREATE INDEX IF NOT EXISTS idx_pitch_eval_lead
      ON pitch_evaluations(lead_id);

    CREATE TABLE IF NOT EXISTS roleplay_sessions (
      id TEXT PRIMARY KEY,
      executive_name TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      scenario_title TEXT NOT NULL,
      persona_prompt TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      score_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_roleplay_exec
      ON roleplay_sessions(executive_name);
  `);
}

