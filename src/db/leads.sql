-- ============================================================
-- IKADOU — leads.sql
-- Safe migration for public lead capture / mobile contact flow
-- ============================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS message TEXT;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_detail VARCHAR(100);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_source_detail
  ON leads(source_detail);

CREATE INDEX IF NOT EXISTS idx_leads_last_contact_at
  ON leads(last_contact_at);