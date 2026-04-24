-- 20260421_payment_method_configs.sql
-- Dynamic client-facing payment methods + project-aware payments

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS payment_method_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(32) NOT NULL CHECK (code IN ('mobile_money', 'bank_transfer', 'cash')),
  label TEXT NOT NULL,
  description TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  priority INT NOT NULL DEFAULT 100,
  country_code VARCHAR(8) NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  instructions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  rules_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_method_configs_active_priority
  ON payment_method_configs(is_active, priority);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_method_configs_code_country_currency
  ON payment_method_configs(code, COALESCE(country_code, ''), currency);

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
      CHECK (payment_purpose IN ('reservation', 'installment', 'balance', 'full_purchase', 'fees', 'other'));
  END IF;
END
$$;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS client_instruction_note TEXT NULL;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(32) NULL;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS proof_status VARCHAR(32) NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payments_proof_status_check'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_proof_status_check
      CHECK (proof_status IN ('none', 'submitted', 'under_review', 'approved', 'rejected'));
  END IF;
END
$$;

-- Seed initial payment methods if absent
INSERT INTO payment_method_configs (
  code,
  label,
  description,
  is_active,
  priority,
  country_code,
  currency,
  instructions_json,
  rules_json
)
SELECT
  'mobile_money',
  'Mobile Money',
  'Payez rapidement avec votre numéro mobile.',
  TRUE,
  10,
  'ML',
  'XOF',
  '{
    "accounts": []
  }'::jsonb,
  '{
    "recommended_for_phone_prefixes": ["+223", "00223"]
  }'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM payment_method_configs
  WHERE code = 'mobile_money' AND COALESCE(country_code, '') = 'ML' AND currency = 'XOF'
);

INSERT INTO payment_method_configs (
  code,
  label,
  description,
  is_active,
  priority,
  country_code,
  currency,
  instructions_json,
  rules_json
)
SELECT
  'bank_transfer',
  'Virement bancaire',
  'Effectuez un virement vers un compte Ikadou.',
  TRUE,
  20,
  'ML',
  'XOF',
  '{
    "accounts": []
  }'::jsonb,
  '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM payment_method_configs
  WHERE code = 'bank_transfer' AND COALESCE(country_code, '') = 'ML' AND currency = 'XOF'
);

INSERT INTO payment_method_configs (
  code,
  label,
  description,
  is_active,
  priority,
  country_code,
  currency,
  instructions_json,
  rules_json
)
SELECT
  'cash',
  'Cash',
  'Payez directement auprès de Ikadou.',
  TRUE,
  30,
  'ML',
  'XOF',
  '{
    "locations": []
  }'::jsonb,
  '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM payment_method_configs
  WHERE code = 'cash' AND COALESCE(country_code, '') = 'ML' AND currency = 'XOF'
);

-- Backfill payment_method where possible
UPDATE payments
SET payment_method = COALESCE(
  payment_method,
  method_type::text,
  provider::text
)
WHERE payment_method IS NULL;

-- Backfill client instruction note with a safe default for existing rows
UPDATE payments
SET client_instruction_note = COALESCE(
  client_instruction_note,
  CASE
    WHEN payment_method = 'mobile_money' THEN 'Effectuez votre paiement Mobile Money puis envoyez votre preuve.'
    WHEN payment_method = 'bank_transfer' THEN 'Effectuez le virement puis envoyez votre preuve.'
    WHEN payment_method = 'cash' THEN 'Présentez-vous dans un point de paiement Ikadou pour régler ce montant.'
    ELSE 'Suivez les instructions communiquées par Ikadou pour finaliser votre paiement.'
  END
)
WHERE client_instruction_note IS NULL;