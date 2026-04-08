-- ============================================================
-- IKADOU — Client app / mobile auth extension schema
-- Run after main schema.sql, payment_schema.sql, notification_schema.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1) Client auth accounts
-- ------------------------------------------------------------
-- Separate auth layer for mobile app users.
-- Keeps backoffice auth (internal_users) isolated from app auth (clients).

CREATE TABLE IF NOT EXISTS client_auth_accounts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id           UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  email               VARCHAR(255) UNIQUE,
  phone               VARCHAR(30) UNIQUE,
  password_hash       TEXT NOT NULL,
  is_email_verified   BOOLEAN DEFAULT FALSE,
  is_phone_verified   BOOLEAN DEFAULT FALSE,
  is_active           BOOLEAN DEFAULT TRUE,
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_client_auth_email_or_phone
    CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_client_id
  ON client_auth_accounts(client_id);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_email
  ON client_auth_accounts(email);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_phone
  ON client_auth_accounts(phone);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_active
  ON client_auth_accounts(is_active);

-- ------------------------------------------------------------
-- 2) OTP codes
-- ------------------------------------------------------------
-- Used for signup / contact verification.
-- OTP mandatory for both email and phone at signup, per product rule.

DO $$ BEGIN
  CREATE TYPE client_otp_channel AS ENUM ('email', 'sms');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE client_otp_purpose AS ENUM (
    'signup_email',
    'signup_phone',
    'verify_email',
    'verify_phone',
    'reset_password'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS client_otp_codes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  account_id      UUID REFERENCES client_auth_accounts(id) ON DELETE CASCADE,
  target          VARCHAR(255) NOT NULL,
  channel         client_otp_channel NOT NULL,
  purpose         client_otp_purpose NOT NULL,
  code_hash       TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 5,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_client_otp_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT chk_client_otp_max_attempts_positive CHECK (max_attempts > 0)
);

CREATE INDEX IF NOT EXISTS idx_client_otp_codes_client_id
  ON client_otp_codes(client_id);

CREATE INDEX IF NOT EXISTS idx_client_otp_codes_account_id
  ON client_otp_codes(account_id);

CREATE INDEX IF NOT EXISTS idx_client_otp_codes_target
  ON client_otp_codes(target);

CREATE INDEX IF NOT EXISTS idx_client_otp_codes_purpose
  ON client_otp_codes(purpose);

CREATE INDEX IF NOT EXISTS idx_client_otp_codes_expires_at
  ON client_otp_codes(expires_at);

CREATE INDEX IF NOT EXISTS idx_client_otp_codes_active_lookup
  ON client_otp_codes(target, purpose, consumed_at, expires_at);

-- ------------------------------------------------------------
-- 3) Client refresh tokens
-- ------------------------------------------------------------
-- Mirrors the existing refresh_tokens pattern used for internal_users,
-- but scoped to mobile app clients.

CREATE TABLE IF NOT EXISTS client_refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_refresh_tokens_client_id
  ON client_refresh_tokens(client_id);

CREATE INDEX IF NOT EXISTS idx_client_refresh_tokens_expires_at
  ON client_refresh_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_client_refresh_tokens_revoked_at
  ON client_refresh_tokens(revoked_at);

-- ------------------------------------------------------------
-- 4) Client app state
-- ------------------------------------------------------------
-- Stores app-specific progression like onboarding completion.

CREATE TABLE IF NOT EXISTS client_app_state (
  client_id                   UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  onboarding_completed        BOOLEAN DEFAULT FALSE,
  onboarding_completed_at     TIMESTAMPTZ,
  onboarding_version          VARCHAR(50),
  last_seen_app_version       VARCHAR(50),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create app state when a client is inserted
CREATE OR REPLACE FUNCTION create_default_client_app_state()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO client_app_state (client_id)
  VALUES (NEW.id)
  ON CONFLICT (client_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_client_app_state ON clients;
CREATE TRIGGER trg_client_app_state
  AFTER INSERT ON clients
  FOR EACH ROW
  EXECUTE FUNCTION create_default_client_app_state();

-- ------------------------------------------------------------
-- 5) Lead -> client conversion helpers
-- ------------------------------------------------------------
-- Helps preserve continuity when a prospect becomes a client.
-- Existing leads can be linked automatically to the newly created client.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS converted_by VARCHAR(50) DEFAULT 'system';

CREATE INDEX IF NOT EXISTS idx_leads_client_id
  ON leads(client_id);

CREATE INDEX IF NOT EXISTS idx_leads_converted_at
  ON leads(converted_at);

-- ------------------------------------------------------------
-- 6) Optional signup / auth audit trail
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_auth_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE SET NULL,
  account_id      UUID REFERENCES client_auth_accounts(id) ON DELETE SET NULL,
  event_type      VARCHAR(50) NOT NULL,
  channel         VARCHAR(20),
  metadata        JSONB DEFAULT '{}',
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_auth_events_client_id
  ON client_auth_events(client_id);

CREATE INDEX IF NOT EXISTS idx_client_auth_events_account_id
  ON client_auth_events(account_id);

CREATE INDEX IF NOT EXISTS idx_client_auth_events_event_type
  ON client_auth_events(event_type);

CREATE INDEX IF NOT EXISTS idx_client_auth_events_created_at
  ON client_auth_events(created_at DESC);

-- ------------------------------------------------------------
-- 7) Auto-update updated_at
-- ------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_updated_at_client_auth_accounts'
  ) THEN
    CREATE TRIGGER trg_updated_at_client_auth_accounts
      BEFORE UPDATE ON client_auth_accounts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_updated_at_client_app_state'
  ) THEN
    CREATE TRIGGER trg_updated_at_client_app_state
      BEFORE UPDATE ON client_app_state
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ------------------------------------------------------------
-- 8) Seed-safe defaults / backfill
-- ------------------------------------------------------------

-- Create app_state rows for existing clients
INSERT INTO client_app_state (client_id)
SELECT c.id
FROM clients c
LEFT JOIN client_app_state cas ON cas.client_id = c.id
WHERE cas.client_id IS NULL
ON CONFLICT (client_id) DO NOTHING;

-- ------------------------------------------------------------
-- 9) Notes
-- ------------------------------------------------------------
-- - Signup requires OTP for both email and phone.
-- - Login can remain password-based without OTP.
-- - Public catalog remains terrain.status = 'published' only.
-- - Visit booking should be client-only at API level, not guest.
-- - Existing leads can be linked to a created client by matching email/phone
--   in application logic, then updating:
--     leads.client_id = clients.id
--     leads.status = 'converted'
--     leads.converted_at = NOW()
--     leads.converted_by = 'system' or user context