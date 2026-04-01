-- ============================================================
-- IKADOU — Notifications extension schema
-- Run: psql -d ikadou_db -f notification_schema.sql
-- ============================================================

-- ─── Device tokens (FCM push) ────────────────────────────

CREATE TABLE IF NOT EXISTS client_device_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    VARCHAR(10) NOT NULL CHECK (platform IN ('ios','android','web')),
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, token)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_client ON client_device_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_active ON client_device_tokens(is_active);

-- ─── Notification preferences per client ─────────────────

CREATE TABLE IF NOT EXISTS client_notification_prefs (
  client_id         UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  email_enabled     BOOLEAN DEFAULT TRUE,
  sms_enabled       BOOLEAN DEFAULT TRUE,
  push_enabled      BOOLEAN DEFAULT TRUE,
  whatsapp_enabled  BOOLEAN DEFAULT FALSE,
  visit_notifs      BOOLEAN DEFAULT TRUE,
  payment_notifs    BOOLEAN DEFAULT TRUE,
  promo_notifs      BOOLEAN DEFAULT TRUE,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Add push_token column to clients ────────────────────
-- (convenience cache, source of truth is client_device_tokens)

ALTER TABLE clients ADD COLUMN IF NOT EXISTS push_token TEXT;

-- ─── Trigger: auto-create prefs on client insert ─────────

CREATE OR REPLACE FUNCTION create_default_notif_prefs()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO client_notification_prefs (client_id)
  VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_client_notif_prefs ON clients;
CREATE TRIGGER trg_client_notif_prefs
  AFTER INSERT ON clients
  FOR EACH ROW EXECUTE FUNCTION create_default_notif_prefs();

-- ─── Notification queue (for retry / scheduling) ──────────

CREATE TABLE IF NOT EXISTS notification_queue (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel       notification_channel NOT NULL,
  type          VARCHAR(100) NOT NULL,
  recipient     VARCHAR(255) NOT NULL,
  subject       VARCHAR(255),
  content       TEXT,
  variables     JSONB DEFAULT '{}',
  related_type  VARCHAR(50),
  related_id    UUID,
  scheduled_at  TIMESTAMPTZ DEFAULT NOW(),
  attempts      INT DEFAULT 0,
  max_attempts  INT DEFAULT 3,
  status        VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  error_reason  TEXT,
  sent_by       UUID REFERENCES internal_users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notif_queue_status ON notification_queue(status, scheduled_at);

-- ─── Notification settings (backoffice controlled) ────────

CREATE TABLE IF NOT EXISTS notification_settings (
  key           VARCHAR(100) PRIMARY KEY,
  value         TEXT NOT NULL,
  description   TEXT,
  updated_by    UUID REFERENCES internal_users(id),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Defaults
INSERT INTO notification_settings (key, value, description) VALUES
  ('email_enabled',     'true',  'Activer les notifications email'),
  ('sms_enabled',       'true',  'Activer les notifications SMS'),
  ('push_enabled',      'true',  'Activer les notifications push'),
  ('whatsapp_enabled',  'false', 'Activer les notifications WhatsApp'),
  ('visit_reminder_hours', '24', 'Heures avant la visite pour envoyer le rappel'),
  ('support_phone',     '+22300000000', 'Numéro support affiché dans les SMS')
ON CONFLICT (key) DO NOTHING;