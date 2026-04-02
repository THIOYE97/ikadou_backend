-- ============================================================
-- IKADOU — Payment providers extension schema
-- Run after main schema.sql
-- ============================================================

-- ─── Payment provider enum ───────────────────────────────

DO $$ BEGIN
  CREATE TYPE payment_provider AS ENUM ('stripe', 'danapay', 'manual', 'bank_transfer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method_type AS ENUM (
    'card', 'sepa_debit',
    'mobile_money', 'wave', 'orange_money', 'free_money', 'moov_money',
    'bank_transfer', 'cash', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Extend payments table ───────────────────────────────

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider          payment_provider DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS provider_ref      VARCHAR(255),   -- Stripe PaymentIntent ID / DanaPay transfer ID
  ADD COLUMN IF NOT EXISTS provider_status   VARCHAR(100),   -- raw status from provider
  ADD COLUMN IF NOT EXISTS method_type       payment_method_type DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS checkout_url      TEXT,           -- Stripe/DanaPay redirect URL
  ADD COLUMN IF NOT EXISTS expires_at        TIMESTAMPTZ,    -- checkout link expiry
  ADD COLUMN IF NOT EXISTS metadata          JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS installment_total INT DEFAULT 1,  -- nombre d'échéances
  ADD COLUMN IF NOT EXISTS installment_num   INT DEFAULT 1;  -- numéro d'échéance

-- ─── Payment installments (plan de paiement échelonné) ───

CREATE TABLE IF NOT EXISTS payment_installments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id     UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  installment_num INT NOT NULL,
  amount         NUMERIC(15, 2) NOT NULL,
  currency       payment_currency NOT NULL DEFAULT 'XOF',
  due_date       DATE NOT NULL,
  status         payment_status NOT NULL DEFAULT 'pending',
  provider_ref   VARCHAR(255),
  paid_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_installments_payment ON payment_installments(payment_id);
CREATE INDEX IF NOT EXISTS idx_installments_due     ON payment_installments(due_date);
CREATE INDEX IF NOT EXISTS idx_installments_status  ON payment_installments(status);

-- ─── Provider webhook events log ─────────────────────────

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider     payment_provider NOT NULL,
  event_id     VARCHAR(255),           -- Stripe event id / DanaPay event id
  event_type   VARCHAR(100) NOT NULL,
  payload      JSONB NOT NULL,
  processed    BOOLEAN DEFAULT FALSE,
  payment_id   UUID REFERENCES payments(id),
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider ON payment_webhook_events(provider, processed);
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id ON payment_webhook_events(event_id);

-- ─── Update notification_settings with payment defaults ──

INSERT INTO notification_settings (key, value, description) VALUES
  ('stripe_enabled',  'true', 'Activer les paiements Stripe (carte bancaire)'),
  ('danapay_enabled', 'true', 'Activer les paiements DanaPay (Mobile Money)')
ON CONFLICT (key) DO NOTHING;