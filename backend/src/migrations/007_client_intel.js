/**
 * Migration 007: Client Intel tables.
 * Stores verified 360-degree client profiling data extracted from BD pitch calls:
 * Category A: Company Profile (MCA / audited real turnover, employee count, location, website)
 * Category B: Contact Person Profile (name, email, role, department, authority)
 * Category C: Sales Intelligence (lead temperature, need, current vendor, problem, budget, follow-up)
 */
export const id = '007_client_intel';

export function up(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS client_intel (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL DEFAULT 'call',
      target_id TEXT NOT NULL,
      lead_id TEXT,
      call_id TEXT,
      
      -- Category A: Company Profile
      company_name TEXT,
      company_website TEXT,
      industry TEXT,
      company_email TEXT,
      location TEXT,
      employee_count TEXT,
      annual_turnover TEXT,
      company_type TEXT,
      business_category TEXT,
      
      -- Category B: Contact Person Profile
      contact_name TEXT,
      contact_email TEXT,
      contact_designation TEXT,
      contact_department TEXT,
      contact_phone TEXT,
      decision_maker TEXT,
      seniority TEXT,
      
      -- Category C: Sales Intelligence
      lead_temperature TEXT DEFAULT 'Warm',
      lead_source TEXT DEFAULT 'Calling',
      client_requirement TEXT,
      current_vendor TEXT,
      main_problem TEXT,
      budget TEXT,
      last_interaction TEXT,
      next_followup TEXT,
      
      -- Metadata & Verification
      raw_transcript TEXT,
      extraction_source TEXT DEFAULT 'ai_mca_hybrid',
      is_verified INTEGER DEFAULT 1,
      synced_to_zoho INTEGER DEFAULT 0,
      zoho_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(target_type, target_id)
    );

    CREATE INDEX IF NOT EXISTS idx_client_intel_target
      ON client_intel(target_type, target_id);

    CREATE INDEX IF NOT EXISTS idx_client_intel_company
      ON client_intel(company_name);

    CREATE INDEX IF NOT EXISTS idx_client_intel_lead
      ON client_intel(lead_id);
  `);
}
