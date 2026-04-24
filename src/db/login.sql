-- ============================================================
-- IKADOU — CLIENT MOBILE AUTH FULL SCHEMA (single-file migration)
-- Email + password
-- Phone login/register via OTP only
-- Google Sign-In
-- OTP mandatory at register
-- Login step-up OTP only if last strong verification > 7 days
-- Password reset supported for password-enabled accounts
--
-- Safe / idempotent migration
-- PostgreSQL
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0) Extensions
-- ------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- 1) Helpers
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Small helper to safely create enum values if type exists
-- (used through DO blocks below)

-- ------------------------------------------------------------
-- 2) Base enums
-- ------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE client_otp_channel AS ENUM ('email', 'sms', 'whatsapp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE client_otp_purpose AS ENUM (
    'register_email',
    'register_phone',
    'login_phone',
    'login_reverify',
    'verify_email',
    'verify_phone',
    'verify_contact',
    'reset_password'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE client_login_method AS ENUM ('email', 'phone', 'google');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE client_auth_provider AS ENUM ('google');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE client_auth_challenge_type AS ENUM ('login_reverify', 'contact_verification');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE client_auth_challenge_status AS ENUM ('pending', 'completed', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- If older enum versions already exist, add missing values safely
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'client_otp_channel') THEN
    BEGIN ALTER TYPE client_otp_channel ADD VALUE IF NOT EXISTS 'whatsapp'; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'client_otp_purpose') THEN
    BEGIN ALTER TYPE client_otp_purpose ADD VALUE IF NOT EXISTS 'register_email'; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER TYPE client_otp_purpose ADD VALUE IF NOT EXISTS 'register_phone'; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER TYPE client_otp_purpose ADD VALUE IF NOT EXISTS 'login_phone'; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER TYPE client_otp_purpose ADD VALUE IF NOT EXISTS 'login_reverify'; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER TYPE client_otp_purpose ADD VALUE IF NOT EXISTS 'verify_contact'; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3) Core auth account
-- ------------------------------------------------------------
-- Assumes clients(id) already exists in main schema.
-- One auth account per client.

CREATE TABLE IF NOT EXISTS client_auth_accounts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                 UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,

  email                     VARCHAR(255) UNIQUE,
  phone                     VARCHAR(30) UNIQUE,

  -- Nullable because phone login is OTP-only and Google can be passwordless
  password_hash             TEXT NULL,

  -- Verification state
  is_email_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  is_phone_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,

  email_verified_at         TIMESTAMPTZ NULL,
  phone_verified_at         TIMESTAMPTZ NULL,
  whatsapp_verified_at      TIMESTAMPTZ NULL,

  -- Google auth support
  google_sub                VARCHAR(255) UNIQUE,
  google_email              VARCHAR(255),

  -- Helpful metadata
  auth_methods              JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_login           VARCHAR(20) NULL,
  preferred_otp_channel     VARCHAR(20) NULL,
  last_login_method         VARCHAR(20) NULL,

  -- Step-up auth / trust window
  last_login_at             TIMESTAMPTZ NULL,
  last_strong_verified_at   TIMESTAMPTZ NULL,

  -- Abuse / lock
  failed_login_attempts     INT NOT NULL DEFAULT 0,
  locked_until              TIMESTAMPTZ NULL,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_client_auth_email_phone_or_google
    CHECK (
      email IS NOT NULL
      OR phone IS NOT NULL
      OR google_sub IS NOT NULL
    ),

  CONSTRAINT chk_client_auth_accounts_preferred_login
    CHECK (
      preferred_login IS NULL
      OR preferred_login IN ('email', 'phone', 'google')
    ),

  CONSTRAINT chk_client_auth_accounts_preferred_otp_channel
    CHECK (
      preferred_otp_channel IS NULL
      OR preferred_otp_channel IN ('email', 'sms', 'whatsapp')
    ),

  CONSTRAINT chk_client_auth_accounts_last_login_method
    CHECK (
      last_login_method IS NULL
      OR last_login_method IN ('email', 'phone', 'google')
    ),

  CONSTRAINT chk_client_auth_accounts_failed_login_attempts
    CHECK (failed_login_attempts >= 0)
);

-- Upgrade older table if it already exists
ALTER TABLE client_auth_accounts
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE client_auth_accounts
  ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255),
  ADD COLUMN IF NOT EXISTS google_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS auth_methods JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS preferred_login VARCHAR(20),
  ADD COLUMN IF NOT EXISTS preferred_otp_channel VARCHAR(20),
  ADD COLUMN IF NOT EXISTS last_login_method VARCHAR(20),
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_strong_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

ALTER TABLE client_auth_accounts
  DROP CONSTRAINT IF EXISTS chk_client_auth_email_or_phone;

ALTER TABLE client_auth_accounts
  DROP CONSTRAINT IF EXISTS chk_client_auth_email_phone_or_google;

ALTER TABLE client_auth_accounts
  ADD CONSTRAINT chk_client_auth_email_phone_or_google
  CHECK (
    email IS NOT NULL
    OR phone IS NOT NULL
    OR google_sub IS NOT NULL
  );

ALTER TABLE client_auth_accounts
  DROP CONSTRAINT IF EXISTS chk_client_auth_accounts_preferred_login;

ALTER TABLE client_auth_accounts
  ADD CONSTRAINT chk_client_auth_accounts_preferred_login
  CHECK (
    preferred_login IS NULL
    OR preferred_login IN ('email', 'phone', 'google')
  );

ALTER TABLE client_auth_accounts
  DROP CONSTRAINT IF EXISTS chk_client_auth_accounts_preferred_otp_channel;

ALTER TABLE client_auth_accounts
  ADD CONSTRAINT chk_client_auth_accounts_preferred_otp_channel
  CHECK (
    preferred_otp_channel IS NULL
    OR preferred_otp_channel IN ('email', 'sms', 'whatsapp')
  );

ALTER TABLE client_auth_accounts
  DROP CONSTRAINT IF EXISTS chk_client_auth_accounts_last_login_method;

ALTER TABLE client_auth_accounts
  ADD CONSTRAINT chk_client_auth_accounts_last_login_method
  CHECK (
    last_login_method IS NULL
    OR last_login_method IN ('email', 'phone', 'google')
  );

ALTER TABLE client_auth_accounts
  DROP CONSTRAINT IF EXISTS chk_client_auth_accounts_failed_login_attempts;

ALTER TABLE client_auth_accounts
  ADD CONSTRAINT chk_client_auth_accounts_failed_login_attempts
  CHECK (failed_login_attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_client_id
  ON client_auth_accounts(client_id);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_email
  ON client_auth_accounts(email);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_phone
  ON client_auth_accounts(phone);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_active
  ON client_auth_accounts(is_active);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_google_sub
  ON client_auth_accounts(google_sub);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_google_email
  ON client_auth_accounts(google_email);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_last_strong_verified_at
  ON client_auth_accounts(last_strong_verified_at);

CREATE INDEX IF NOT EXISTS idx_client_auth_accounts_locked_until
  ON client_auth_accounts(locked_until);

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_auth_accounts_google_sub
  ON client_auth_accounts(google_sub)
  WHERE google_sub IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_auth_accounts_email
  ON client_auth_accounts(email)
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_auth_accounts_phone
  ON client_auth_accounts(phone)
  WHERE phone IS NOT NULL;

CREATE TRIGGER trg_updated_at_client_auth_accounts
BEFORE UPDATE ON client_auth_accounts
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Backfill verification timestamps when flags already exist
UPDATE client_auth_accounts
SET email_verified_at = COALESCE(email_verified_at, updated_at, created_at)
WHERE is_email_verified = TRUE
  AND email_verified_at IS NULL;

UPDATE client_auth_accounts
SET phone_verified_at = COALESCE(phone_verified_at, updated_at, created_at)
WHERE is_phone_verified = TRUE
  AND phone_verified_at IS NULL;

UPDATE client_auth_accounts
SET last_strong_verified_at = COALESCE(
  last_strong_verified_at,
  GREATEST(
    COALESCE(email_verified_at, '-infinity'::timestamptz),
    COALESCE(phone_verified_at, '-infinity'::timestamptz),
    COALESCE(updated_at, created_at)
  )
)
WHERE last_strong_verified_at IS NULL
  AND (is_email_verified = TRUE OR is_phone_verified = TRUE);

-- Backfill auth_methods
UPDATE client_auth_accounts
SET auth_methods = (
  SELECT to_jsonb(array_remove(ARRAY[
    CASE WHEN email IS NOT NULL AND password_hash IS NOT NULL THEN 'email_password' END,
    CASE WHEN phone IS NOT NULL THEN 'phone_otp' END,
    CASE WHEN google_sub IS NOT NULL THEN 'google' END
  ], NULL))
)
WHERE auth_methods = '[]'::jsonb;

-- ------------------------------------------------------------
-- 4) Linked identities (future-proof)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_auth_identities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES client_auth_accounts(id) ON DELETE CASCADE,
  provider            VARCHAR(30) NOT NULL,
  provider_user_id    VARCHAR(255) NOT NULL,
  provider_email      VARCHAR(255) NULL,
  provider_phone      VARCHAR(50) NULL,
  access_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_client_auth_identities_provider
    CHECK (provider IN ('google')),

  CONSTRAINT uq_client_auth_identities_provider_user
    UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_client_auth_identities_account_id
  ON client_auth_identities(account_id);

CREATE INDEX IF NOT EXISTS idx_client_auth_identities_provider_email
  ON client_auth_identities(provider_email);

CREATE TRIGGER trg_updated_at_client_auth_identities
BEFORE UPDATE ON client_auth_identities
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 5) OTP codes
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_otp_codes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID NULL REFERENCES clients(id) ON DELETE CASCADE,
  account_id            UUID NULL REFERENCES client_auth_accounts(id) ON DELETE CASCADE,

  target                VARCHAR(255) NOT NULL,
  channel               client_otp_channel NOT NULL,
  purpose               client_otp_purpose NOT NULL,

  code_hash             TEXT NOT NULL,

  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ NULL,

  attempts              INT NOT NULL DEFAULT 0,
  max_attempts          INT NOT NULL DEFAULT 5,
  resend_count          INT NOT NULL DEFAULT 0,

  delivery_status       VARCHAR(30) NOT NULL DEFAULT 'pending',
  delivery_provider     VARCHAR(50) NULL,
  delivery_reference    VARCHAR(255) NULL,
  delivery_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,

  verified_session_id   UUID NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_client_otp_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT chk_client_otp_max_attempts_positive CHECK (max_attempts > 0),
  CONSTRAINT chk_client_otp_resend_count_non_negative CHECK (resend_count >= 0),
  CONSTRAINT chk_client_otp_delivery_status CHECK (
    delivery_status IN ('pending', 'sent', 'delivered', 'failed', 'consumed', 'expired')
  )
);

ALTER TABLE client_otp_codes
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS delivery_provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS delivery_reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS delivery_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS verified_session_id UUID,
  ADD COLUMN IF NOT EXISTS resend_count INT NOT NULL DEFAULT 0;

ALTER TABLE client_otp_codes
  DROP CONSTRAINT IF EXISTS chk_client_otp_attempts_non_negative;

ALTER TABLE client_otp_codes
  ADD CONSTRAINT chk_client_otp_attempts_non_negative CHECK (attempts >= 0);

ALTER TABLE client_otp_codes
  DROP CONSTRAINT IF EXISTS chk_client_otp_max_attempts_positive;

ALTER TABLE client_otp_codes
  ADD CONSTRAINT chk_client_otp_max_attempts_positive CHECK (max_attempts > 0);

ALTER TABLE client_otp_codes
  DROP CONSTRAINT IF EXISTS chk_client_otp_resend_count_non_negative;

ALTER TABLE client_otp_codes
  ADD CONSTRAINT chk_client_otp_resend_count_non_negative CHECK (resend_count >= 0);

ALTER TABLE client_otp_codes
  DROP CONSTRAINT IF EXISTS chk_client_otp_delivery_status;

ALTER TABLE client_otp_codes
  ADD CONSTRAINT chk_client_otp_delivery_status CHECK (
    delivery_status IN ('pending', 'sent', 'delivered', 'failed', 'consumed', 'expired')
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

CREATE INDEX IF NOT EXISTS idx_client_otp_codes_target_purpose_created
  ON client_otp_codes(target, purpose, created_at DESC);

-- Helpful partial index for active OTP lookup
CREATE INDEX IF NOT EXISTS idx_client_otp_codes_active_unconsumed
  ON client_otp_codes(target, channel, purpose, expires_at DESC)
  WHERE consumed_at IS NULL;

-- ------------------------------------------------------------
-- 6) Refresh tokens
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_refresh_tokens (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token                 TEXT NOT NULL UNIQUE,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_refresh_tokens_client_id
  ON client_refresh_tokens(client_id);

CREATE INDEX IF NOT EXISTS idx_client_refresh_tokens_expires_at
  ON client_refresh_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_client_refresh_tokens_revoked_at
  ON client_refresh_tokens(revoked_at);

-- ------------------------------------------------------------
-- 7) Auth sessions
-- ------------------------------------------------------------
-- Used for device/session tracking and 7-day trust rule.

CREATE TABLE IF NOT EXISTS client_auth_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  account_id            UUID NOT NULL REFERENCES client_auth_accounts(id) ON DELETE CASCADE,
  refresh_token_id      UUID NULL REFERENCES client_refresh_tokens(id) ON DELETE SET NULL,

  login_method          VARCHAR(20) NOT NULL,
  device_label          VARCHAR(150) NULL,
  device_id             VARCHAR(255) NULL,
  platform              VARCHAR(20) NULL,
  app_version           VARCHAR(50) NULL,
  ip_address            INET NULL,
  user_agent            TEXT NULL,

  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at      TIMESTAMPTZ NULL,
  expires_at            TIMESTAMPTZ NULL,
  revoked_at            TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_client_auth_sessions_login_method
    CHECK (login_method IN ('email', 'phone', 'google'))
);

CREATE INDEX IF NOT EXISTS idx_client_auth_sessions_client_id
  ON client_auth_sessions(client_id);

CREATE INDEX IF NOT EXISTS idx_client_auth_sessions_account_id
  ON client_auth_sessions(account_id);

CREATE INDEX IF NOT EXISTS idx_client_auth_sessions_refresh_token_id
  ON client_auth_sessions(refresh_token_id);

CREATE INDEX IF NOT EXISTS idx_client_auth_sessions_last_verified_at
  ON client_auth_sessions(last_verified_at);

CREATE INDEX IF NOT EXISTS idx_client_auth_sessions_device_id
  ON client_auth_sessions(device_id);

-- ------------------------------------------------------------
-- 8) Step-up / verification challenges
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_auth_challenges (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES client_auth_accounts(id) ON DELETE CASCADE,
  session_id            UUID NULL REFERENCES client_auth_sessions(id) ON DELETE CASCADE,

  challenge_type        VARCHAR(30) NOT NULL,
  target                VARCHAR(255) NOT NULL,
  channel               VARCHAR(20) NOT NULL,

  status                VARCHAR(20) NOT NULL DEFAULT 'pending',
  expires_at            TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ NULL,

  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_client_auth_challenges_type
    CHECK (challenge_type IN ('login_reverify', 'contact_verification')),

  CONSTRAINT chk_client_auth_challenges_channel
    CHECK (channel IN ('email', 'sms', 'whatsapp')),

  CONSTRAINT chk_client_auth_challenges_status
    CHECK (status IN ('pending', 'completed', 'expired', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_client_auth_challenges_account_id
  ON client_auth_challenges(account_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_auth_challenges_session_id
  ON client_auth_challenges(session_id);

-- ------------------------------------------------------------
-- 9) App state
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_app_state (
  client_id                   UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  onboarding_completed        BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_completed_at     TIMESTAMPTZ NULL,
  onboarding_version          VARCHAR(50) NULL,
  last_seen_app_version       VARCHAR(50) NULL,

  -- Optional onboarding flags
  primary_contact_type        VARCHAR(20) NULL,
  has_password                BOOLEAN NOT NULL DEFAULT FALSE,
  google_linked               BOOLEAN NOT NULL DEFAULT FALSE,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_client_app_state_primary_contact_type
    CHECK (
      primary_contact_type IS NULL
      OR primary_contact_type IN ('email', 'phone')
    )
);

ALTER TABLE client_app_state
  ADD COLUMN IF NOT EXISTS primary_contact_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS has_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS google_linked BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE client_app_state
  DROP CONSTRAINT IF EXISTS chk_client_app_state_primary_contact_type;

ALTER TABLE client_app_state
  ADD CONSTRAINT chk_client_app_state_primary_contact_type
  CHECK (
    primary_contact_type IS NULL
    OR primary_contact_type IN ('email', 'phone')
  );

CREATE TRIGGER trg_updated_at_client_app_state
BEFORE UPDATE ON client_app_state
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

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

-- Backfill for existing clients
INSERT INTO client_app_state (client_id)
SELECT c.id
FROM clients c
LEFT JOIN client_app_state cas ON cas.client_id = c.id
WHERE cas.client_id IS NULL
ON CONFLICT (client_id) DO NOTHING;

-- Sync app-state helper flags from auth accounts
UPDATE client_app_state cas
SET
  has_password = COALESCE(caa.password_hash IS NOT NULL, FALSE),
  google_linked = COALESCE(caa.google_sub IS NOT NULL, FALSE),
  primary_contact_type = CASE
    WHEN caa.phone IS NOT NULL AND caa.email IS NULL THEN 'phone'
    WHEN caa.email IS NOT NULL THEN 'email'
    ELSE cas.primary_contact_type
  END
FROM client_auth_accounts caa
WHERE cas.client_id = caa.client_id;

-- ------------------------------------------------------------
-- 10) Lead conversion helpers
-- ------------------------------------------------------------

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_by VARCHAR(50) DEFAULT 'system';

CREATE INDEX IF NOT EXISTS idx_leads_client_id
  ON leads(client_id);

CREATE INDEX IF NOT EXISTS idx_leads_converted_at
  ON leads(converted_at);

-- ------------------------------------------------------------
-- 11) Auth events audit trail
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_auth_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID NULL REFERENCES clients(id) ON DELETE SET NULL,
  account_id            UUID NULL REFERENCES client_auth_accounts(id) ON DELETE SET NULL,

  event_type            VARCHAR(50) NOT NULL,
  channel               VARCHAR(20) NULL,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

  ip_address            INET NULL,
  user_agent            TEXT NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
-- 12) Notification preferences bootstrap (if notifications schema exists)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_default_notif_prefs()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO client_notification_prefs (client_id)
  VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
EXCEPTION
  WHEN undefined_table THEN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_client_notif_prefs ON clients;
CREATE TRIGGER trg_client_notif_prefs
AFTER INSERT ON clients
FOR EACH ROW
EXECUTE FUNCTION create_default_notif_prefs();

-- ------------------------------------------------------------
-- 13) Business-rule documentation via SQL comments
-- ------------------------------------------------------------

COMMENT ON TABLE client_auth_accounts IS
'Mobile auth account per client. Supports email/password, phone OTP-only, and Google.';

COMMENT ON COLUMN client_auth_accounts.last_strong_verified_at IS
'Last time the user completed a strong verification (register OTP, phone OTP login, or step-up OTP). Use 7-day rule against this field.';

COMMENT ON TABLE client_otp_codes IS
'Stores hashed OTP codes for register, phone login, step-up login verification, contact verification, and password reset.';

COMMENT ON TABLE client_auth_sessions IS
'Tracks client sessions/devices. Use last_verified_at to manage trusted sessions.';

-- ------------------------------------------------------------
-- 14) Convenience view (optional)
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW v_client_auth_summary AS
SELECT
  caa.id AS account_id,
  caa.client_id,
  caa.email,
  caa.phone,
  caa.google_sub,
  caa.is_email_verified,
  caa.is_phone_verified,
  caa.is_active,
  caa.last_login_at,
  caa.last_strong_verified_at,
  caa.preferred_login,
  caa.preferred_otp_channel,
  cas.onboarding_completed,
  cas.primary_contact_type,
  cas.has_password,
  cas.google_linked
FROM client_auth_accounts caa
LEFT JOIN client_app_state cas
  ON cas.client_id = caa.client_id;

-- ------------------------------------------------------------
-- 15) Final seed-safe updates
-- ------------------------------------------------------------

UPDATE client_auth_accounts
SET preferred_login = CASE
  WHEN preferred_login IS NOT NULL THEN preferred_login
  WHEN google_sub IS NOT NULL THEN 'google'
  WHEN email IS NOT NULL AND password_hash IS NOT NULL THEN 'email'
  WHEN phone IS NOT NULL THEN 'phone'
  ELSE NULL
END
WHERE preferred_login IS NULL;

UPDATE client_auth_accounts
SET preferred_otp_channel = CASE
  WHEN preferred_otp_channel IS NOT NULL THEN preferred_otp_channel
  WHEN phone IS NOT NULL THEN 'sms'
  WHEN email IS NOT NULL THEN 'email'
  ELSE NULL
END
WHERE preferred_otp_channel IS NULL;

COMMIT;

-- ============================================================
-- IMPLEMENTATION NOTES
-- ============================================================
-- Register rules expected in app/backend:
--   1) email register:
--      - create client + client_auth_account(email, password_hash)
--      - send OTP purpose=register_email channel=email
--      - after valid OTP: is_email_verified=true, email_verified_at=now(),
--        last_strong_verified_at=now()
--
--   2) phone register:
--      - create client + client_auth_account(phone, password_hash=NULL)
--      - send OTP purpose=register_phone channel=sms|whatsapp
--      - after valid OTP: is_phone_verified=true, phone_verified_at=now(),
--        last_strong_verified_at=now()
--
--   3) google register/login:
--      - verify Google token server-side
--      - create or find account by google_sub / email
--      - require a verified contact (email or phone) during onboarding
--
-- Login rules expected in app/backend:
--   1) email login:
--      - verify password
--      - if last_strong_verified_at older than 7 days => send OTP
--        purpose=login_reverify via verified email or verified phone
--
--   2) phone login:
--      - no password
--      - send OTP purpose=login_phone via sms|whatsapp
--      - after valid OTP => authenticated
--
--   3) google login:
--      - verify Google token
--      - if last_strong_verified_at older than 7 days => send OTP
--        purpose=login_reverify
--
-- Password reset:
--   - OTP purpose=reset_password to verified email
--   - after valid OTP user can set new password_hash
--
-- Suggested trust rule:
--   needs_step_up = (
--     last_strong_verified_at IS NULL
--     OR last_strong_verified_at < NOW() - INTERVAL '7 days'
--   );