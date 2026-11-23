/**
 * Migration 006: EPR Knowledge Base documents table.
 * Stores extracted text from uploaded PDF, Word (.docx), ZIP, and TXT files
 * so Gemini AI fact-checks calls/WhatsApp chats and generates Smart Playbook rules.
 */
export const id = '006_knowledge_docs';

export function up(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_docs (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      file_type TEXT NOT NULL,
      source_zip TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      char_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_docs_active
      ON knowledge_docs(is_active, updated_at DESC);
  `);
}

