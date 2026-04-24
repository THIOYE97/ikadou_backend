-- ============================================================
-- IKADOU — registration sessions / deferred account creation
-- Le compte client n'est créé qu'après validation OTP
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- updated_at helper
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- Registration session status / flow / channels
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE client_registration_flow AS ENUM ('email', 'phone');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE client_registration_status AS ENUM (
    'pending',
    'verified',
    'expired',
    'cancelled',
    'consumed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE client_registration_channel AS ENUM (
    'email',
    'sms',
    'whatsapp'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────
-- Temporary registration sessions
-- This is the source of truth BEFORE account creation
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_registration_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  flow client_registration_flow NOT NULL,
  status client_registration_status NOT NULL DEFAULT 'pending',

  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,

  email VARCHAR(255) NULL,
  phone VARCHAR(30) NULL,

  password_hash TEXT NULL,

  country TEXT NULL,
  city TEXT NULL,

  current_channel client_registration_channel NOT NULL,
  verification_target TEXT NOT NULL,

  otp_code_hash TEXT NOT NULL,
  otp_expires_at TIMESTAMPTZ NOT NULL,
  otp_attempts INT NOT NULL DEFAULT 0,
  otp_max_attempts INT NOT NULL DEFAULT 5,
  resend_count INT NOT NULL DEFAULT 0,

  verified_at TIMESTAMPTZ NULL,
  consumed_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  expires_reason TEXT NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT client_registration_sessions_email_format_chk
    CHECK (
      email IS NULL
      OR email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'
    ),

  CONSTRAINT client_registration_sessions_phone_not_blank_chk
    CHECK (phone IS NULL OR length(trim(phone)) > 0),

  CONSTRAINT client_registration_sessions_verification_target_not_blank_chk
    CHECK (length(trim(verification_target)) > 0),

  CONSTRAINT client_registration_sessions_attempts_chk
    CHECK (otp_attempts >= 0 AND otp_attempts <= otp_max_attempts),

  CONSTRAINT client_registration_sessions_resend_count_chk
    CHECK (resend_count >= 0),

  CONSTRAINT client_registration_sessions_flow_requirements_chk
    CHECK (
      (flow = 'email'
        AND email IS NOT NULL
        AND password_hash IS NOT NULL
        AND current_channel = 'email')
      OR
      (flow = 'phone'
        AND phone IS NOT NULL
        AND current_channel IN ('sms', 'whatsapp'))
    ),

  CONSTRAINT client_registration_sessions_target_consistency_chk
    CHECK (
      (current_channel = 'email' AND email IS NOT NULL AND verification_target = email)
      OR
      (current_channel IN ('sms', 'whatsapp') AND phone IS NOT NULL AND verification_target = phone)
    )
);

DROP TRIGGER IF EXISTS trg_updated_at_client_registration_sessions ON client_registration_sessions;
CREATE TRIGGER trg_updated_at_client_registration_sessions
BEFORE UPDATE ON client_registration_sessions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_client_registration_sessions_status
  ON client_registration_sessions(status);

CREATE INDEX IF NOT EXISTS idx_client_registration_sessions_flow_status
  ON client_registration_sessions(flow, status);

CREATE INDEX IF NOT EXISTS idx_client_registration_sessions_created_at
  ON client_registration_sessions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_registration_sessions_expires_at
  ON client_registration_sessions(otp_expires_at);

CREATE INDEX IF NOT EXISTS idx_client_registration_sessions_phone
  ON client_registration_sessions(phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_client_registration_sessions_email
  ON client_registration_sessions(LOWER(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_client_registration_sessions_target
  ON client_registration_sessions(verification_target);

-- At most one active pending session per email
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_registration_sessions_active_email
  ON client_registration_sessions(LOWER(email))
  WHERE email IS NOT NULL
    AND status = 'pending';

-- At most one active pending session per phone
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_registration_sessions_active_phone
  ON client_registration_sessions(phone)
  WHERE phone IS NOT NULL
    AND status = 'pending';

-- ─────────────────────────────────────────────────────────────
-- Optional audit trail for resend / verify / cancel / expire
-- Useful for debugging delivery/channel switching
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_registration_session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES client_registration_sessions(id) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL,
  channel client_registration_channel NULL,
  message TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT client_registration_session_events_event_type_chk
    CHECK (
      event_type IN (
        'created',
        'otp_sent',
        'otp_resent',
        'otp_failed',
        'otp_verified',
        'otp_invalid',
        'expired',
        'cancelled',
        'consumed'
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_client_registration_session_events_session
  ON client_registration_session_events(session_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Helpful cleanup function for cron/manual jobs
-- Marks expired pending sessions
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION expire_pending_registration_sessions()
RETURNS INT AS $$
DECLARE
  updated_count INT;
BEGIN
  UPDATE client_registration_sessions
  SET
    status = 'expired',
    expires_reason = COALESCE(expires_reason, 'otp_expired'),
    updated_at = NOW()
  WHERE status = 'pending'
    AND otp_expires_at < NOW();

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- Optional compatibility comments
-- ─────────────────────────────────────────────────────────────
COMMENT ON TABLE client_registration_sessions IS
'Temporary registration state. Real client/account rows must be created only after OTP verification.';

COMMENT ON COLUMN client_registration_sessions.verification_target IS
'Actual destination used for the current OTP send: email or phone depending on channel.';

COMMENT ON COLUMN client_registration_sessions.password_hash IS
'Only set for email registration flow. Phone registration is OTP-only and stores no password here.';




  ALTER TABLE ticket_attachments
ADD COLUMN file_storage_key TEXT;

ALTER TABLE ticket_attachments
ADD COLUMN size_bytes BIGINT;

ALTER TABLE ticket_attachments
ALTER COLUMN file_public_id DROP NOT NULL;