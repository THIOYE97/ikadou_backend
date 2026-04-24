-- 20260421_client_projects.sql
-- Client project tracking for simulation -> visit -> purchase flow
-- Safe/idempotent migration

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS client_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  terrain_id UUID NULL REFERENCES terrains(id) ON DELETE SET NULL,

  title TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  current_step VARCHAR(32) NOT NULL DEFAULT 'simulation'
    CHECK (current_step IN ('simulation', 'visite', 'achat')),

  steps JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  cancel_reason TEXT NULL,
  cancelled_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_projects_client_id
  ON client_projects(client_id);

CREATE INDEX IF NOT EXISTS idx_client_projects_terrain_id
  ON client_projects(terrain_id);

CREATE INDEX IF NOT EXISTS idx_client_projects_status
  ON client_projects(status);

CREATE INDEX IF NOT EXISTS idx_client_projects_client_status_updated
  ON client_projects(client_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_projects_current_step
  ON client_projects(current_step);

CREATE TABLE IF NOT EXISTS client_project_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  action VARCHAR(64) NOT NULL,
  field TEXT NULL,
  old_value JSONB NULL,
  new_value JSONB NULL,
  comment TEXT NULL,
  actor_type VARCHAR(32) NOT NULL DEFAULT 'system'
    CHECK (actor_type IN ('client', 'internal_user', 'system')),
  actor_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_project_history_project_id_created_at
  ON client_project_history(project_id, created_at DESC);

ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS project_id UUID NULL REFERENCES client_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_visits_project_id
  ON visits(project_id);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS project_id UUID NULL REFERENCES client_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payments_project_id
  ON payments(project_id);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_purpose VARCHAR(32) NOT NULL DEFAULT 'other';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payments_payment_purpose_check'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_payment_purpose_check
      CHECK (payment_purpose IN ('reservation', 'installment', 'full_purchase', 'fees', 'other'));
  END IF;
END
$$;

-- Normalize project steps for any legacy rows
UPDATE client_projects
SET steps = jsonb_build_object(
  'simulation', jsonb_build_object(
    'key', 'simulation',
    'label', 'Simulation',
    'status', COALESCE(steps->'simulation'->>'status', 'in_progress'),
    'started_at', COALESCE(steps->'simulation'->>'started_at', created_at::text),
    'completed_at', steps->'simulation'->>'completed_at',
    'data', COALESCE(steps->'simulation'->'data', 'null'::jsonb)
  ),
  'visite', jsonb_build_object(
    'key', 'visite',
    'label', 'Visite',
    'status', COALESCE(steps->'visite'->>'status', 'pending'),
    'started_at', steps->'visite'->>'started_at',
    'completed_at', steps->'visite'->>'completed_at',
    'data', COALESCE(steps->'visite'->'data', 'null'::jsonb)
  ),
  'achat', jsonb_build_object(
    'key', 'achat',
    'label', 'Achat',
    'status', COALESCE(steps->'achat'->>'status', 'pending'),
    'started_at', steps->'achat'->>'started_at',
    'completed_at', steps->'achat'->>'completed_at',
    'data', COALESCE(steps->'achat'->'data', 'null'::jsonb)
  )
)
WHERE steps IS NULL
   OR jsonb_typeof(steps) <> 'object'
   OR NOT (steps ? 'simulation')
   OR NOT (steps ? 'visite')
   OR NOT (steps ? 'achat');
