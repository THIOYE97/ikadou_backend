-- ============================================================
-- IKADOU — Database Schema
-- PostgreSQL 15+
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── ENUMS ───────────────────────────────────────────────

CREATE TYPE user_role AS ENUM (
  'super_admin', 'admin', 'manager', 'sales', 'support', 'finance', 'agent'
);

CREATE TYPE user_status AS ENUM ('active', 'inactive', 'suspended');

CREATE TYPE lead_status AS ENUM (
  'new', 'contacted', 'qualified', 'visit_scheduled', 'visit_done',
  'negotiation', 'converted', 'lost', 'duplicate'
);

CREATE TYPE lead_source AS ENUM (
  'landing_page', 'mobile_app', 'referral', 'social_media',
  'whatsapp', 'phone', 'email', 'agent', 'other'
);

CREATE TYPE client_status AS ENUM ('active', 'suspended', 'closed');

CREATE TYPE terrain_status AS ENUM (
  'draft', 'published', 'reserved', 'sold', 'unavailable'
);

CREATE TYPE terrain_availability AS ENUM ('available', 'reserved', 'sold');

CREATE TYPE visit_status AS ENUM (
  'scheduled', 'confirmed', 'done', 'cancelled', 'rescheduled', 'no_show'
);

CREATE TYPE payment_status AS ENUM (
  'pending', 'confirmed', 'failed', 'refunded', 'partial', 'cancelled'
);

CREATE TYPE payment_currency AS ENUM ('XOF', 'EUR', 'USD');

CREATE TYPE document_type AS ENUM (
  'id_card', 'passport', 'proof_of_address', 'title_deed',
  'survey_plan', 'payment_receipt', 'contract', 'other'
);

CREATE TYPE ticket_status AS ENUM (
  'open', 'in_progress', 'waiting_client', 'resolved', 'closed'
);

CREATE TYPE ticket_priority AS ENUM ('low', 'medium', 'high', 'urgent');

CREATE TYPE notification_channel AS ENUM ('email', 'sms', 'push', 'whatsapp', 'in_app');

CREATE TYPE notification_status AS ENUM ('sent', 'failed', 'pending', 'delivered');

-- ─── ZONES ───────────────────────────────────────────────

CREATE TABLE zones (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  region      VARCHAR(100),
  description TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INTERNAL USERS ──────────────────────────────────────

CREATE TABLE internal_users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            user_role NOT NULL DEFAULT 'sales',
  status          user_status NOT NULL DEFAULT 'active',
  avatar_url      TEXT,
  last_login_at   TIMESTAMPTZ,
  created_by      UUID REFERENCES internal_users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── REFRESH TOKENS ──────────────────────────────────────

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── AGENTS ──────────────────────────────────────────────

CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  email           VARCHAR(255) UNIQUE,
  phone           VARCHAR(30),
  zone_id         UUID REFERENCES zones(id),
  status          user_status NOT NULL DEFAULT 'active',
  user_id         UUID REFERENCES internal_users(id),
  bio             TEXT,
  avatar_url      TEXT,
  created_by      UUID REFERENCES internal_users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_zones (
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  zone_id     UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_by UUID REFERENCES internal_users(id),
  PRIMARY KEY (agent_id, zone_id)
);

-- ─── CLIENTS (app users) ─────────────────────────────────

CREATE TABLE clients (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  email           VARCHAR(255) UNIQUE,
  phone           VARCHAR(30),
  country         VARCHAR(100),
  city            VARCHAR(100),
  status          client_status NOT NULL DEFAULT 'active',
  kyc_verified    BOOLEAN DEFAULT FALSE,
  avatar_url      TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── LEADS ───────────────────────────────────────────────

CREATE TABLE leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  email           VARCHAR(255),
  phone           VARCHAR(30),
  country         VARCHAR(100),
  source          lead_source NOT NULL DEFAULT 'other',
  status          lead_status NOT NULL DEFAULT 'new',
  agent_id        UUID REFERENCES agents(id),
  terrain_id      UUID,  -- FK added after terrains table
  client_id       UUID REFERENCES clients(id),
  lost_reason     TEXT,
  duplicate_of    UUID REFERENCES leads(id),
  created_by      UUID REFERENCES internal_users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE lead_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  action      VARCHAR(100) NOT NULL,
  field       VARCHAR(100),
  old_value   TEXT,
  new_value   TEXT,
  comment     TEXT,
  user_id     UUID REFERENCES internal_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE lead_notes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  author_id   UUID REFERENCES internal_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── TERRAINS ────────────────────────────────────────────

CREATE TABLE terrains (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ref             VARCHAR(50) UNIQUE NOT NULL,
  title           VARCHAR(255) NOT NULL,
  description     TEXT,
  price           NUMERIC(15, 2) NOT NULL,
  currency        payment_currency NOT NULL DEFAULT 'XOF',
  surface_m2      NUMERIC(10, 2),
  location        VARCHAR(255),
  zone_id         UUID REFERENCES zones(id),
  latitude        DECIMAL(10, 8),
  longitude       DECIMAL(11, 8),
  status          terrain_status NOT NULL DEFAULT 'draft',
  availability    terrain_availability NOT NULL DEFAULT 'available',
  is_featured     BOOLEAN DEFAULT FALSE,
  amenities       JSONB DEFAULT '[]',
  images          JSONB DEFAULT '[]',
  created_by      UUID REFERENCES internal_users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Add FK from leads to terrains
ALTER TABLE leads ADD CONSTRAINT leads_terrain_id_fkey
  FOREIGN KEY (terrain_id) REFERENCES terrains(id);

CREATE TABLE terrain_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  terrain_id  UUID NOT NULL REFERENCES terrains(id) ON DELETE CASCADE,
  field       VARCHAR(100),
  old_value   TEXT,
  new_value   TEXT,
  comment     TEXT,
  user_id     UUID REFERENCES internal_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── VISITS ──────────────────────────────────────────────

CREATE TABLE visits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id),
  lead_id         UUID REFERENCES leads(id),
  terrain_id      UUID NOT NULL REFERENCES terrains(id),
  agent_id        UUID REFERENCES agents(id),
  visit_date      DATE NOT NULL,
  visit_time      TIME NOT NULL,
  status          visit_status NOT NULL DEFAULT 'scheduled',
  notes           TEXT,
  cancel_reason   TEXT,
  created_by      UUID REFERENCES internal_users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT visit_has_client_or_lead CHECK (
    client_id IS NOT NULL OR lead_id IS NOT NULL
  )
);

CREATE TABLE visit_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  visit_id    UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  action      VARCHAR(100) NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  comment     TEXT,
  user_id     UUID REFERENCES internal_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PAYMENTS ────────────────────────────────────────────

CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ref             VARCHAR(50) UNIQUE NOT NULL DEFAULT CONCAT('PAY-', UPPER(SUBSTRING(REPLACE(uuid_generate_v4()::TEXT, '-', ''), 1, 8))),
  client_id       UUID REFERENCES clients(id),
  terrain_id      UUID REFERENCES terrains(id),
  amount          NUMERIC(15, 2) NOT NULL,
  currency        payment_currency NOT NULL DEFAULT 'XOF',
  status          payment_status NOT NULL DEFAULT 'pending',
  payment_method  VARCHAR(50),
  transaction_ref VARCHAR(255),
  notes           TEXT,
  created_by      UUID REFERENCES internal_users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE payment_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id  UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  action      VARCHAR(100) NOT NULL,
  old_status  payment_status,
  new_status  payment_status,
  comment     TEXT,
  user_id     UUID REFERENCES internal_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DOCUMENTS ───────────────────────────────────────────

CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  original_name   VARCHAR(255),
  type            document_type NOT NULL DEFAULT 'other',
  mime_type       VARCHAR(100),
  size_bytes      BIGINT,
  url             TEXT NOT NULL,
  storage_key     TEXT,
  related_type    VARCHAR(50) NOT NULL,
  related_id      UUID NOT NULL,
  status          VARCHAR(50) DEFAULT 'active',
  uploaded_by     UUID REFERENCES internal_users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── SUPPORT TICKETS ─────────────────────────────────────

CREATE TABLE support_tickets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ref             VARCHAR(50) UNIQUE NOT NULL DEFAULT CONCAT('TKT-', UPPER(SUBSTRING(REPLACE(uuid_generate_v4()::TEXT, '-', ''), 1, 8))),
  client_id       UUID REFERENCES clients(id),
  subject         VARCHAR(255) NOT NULL,
  description     TEXT,
  priority        ticket_priority NOT NULL DEFAULT 'medium',
  status          ticket_status NOT NULL DEFAULT 'open',
  assigned_to     UUID REFERENCES internal_users(id),
  resolved_at     TIMESTAMPTZ,
  created_by      UUID REFERENCES internal_users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ticket_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT FALSE,
  author_id   UUID REFERENCES internal_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ticket_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  action      VARCHAR(100) NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  comment     TEXT,
  user_id     UUID REFERENCES internal_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── NOTIFICATIONS ───────────────────────────────────────

CREATE TABLE notification_templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  type        VARCHAR(100) NOT NULL,
  channel     notification_channel NOT NULL,
  subject     VARCHAR(255),
  content     TEXT NOT NULL,
  variables   JSONB DEFAULT '[]',
  is_active   BOOLEAN DEFAULT TRUE,
  updated_by  UUID REFERENCES internal_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id     UUID REFERENCES notification_templates(id),
  type            VARCHAR(100) NOT NULL,
  channel         notification_channel NOT NULL,
  recipient       VARCHAR(255) NOT NULL,
  subject         VARCHAR(255),
  content         TEXT,
  status          notification_status NOT NULL DEFAULT 'pending',
  error_reason    TEXT,
  related_type    VARCHAR(50),
  related_id      UUID,
  sent_by         UUID REFERENCES internal_users(id),
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── AUDIT LOG ───────────────────────────────────────────

CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES internal_users(id),
  action      VARCHAR(255) NOT NULL,
  entity_type VARCHAR(100),
  entity_id   UUID,
  metadata    JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INDEXES ─────────────────────────────────────────────

CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_agent_id ON leads(agent_id);
CREATE INDEX idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_leads_phone ON leads(phone);

CREATE INDEX idx_clients_status ON clients(status);
CREATE INDEX idx_clients_email ON clients(email);
CREATE INDEX idx_clients_phone ON clients(phone);

CREATE INDEX idx_terrains_status ON terrains(status);
CREATE INDEX idx_terrains_zone_id ON terrains(zone_id);
CREATE INDEX idx_terrains_availability ON terrains(availability);

CREATE INDEX idx_visits_status ON visits(status);
CREATE INDEX idx_visits_visit_date ON visits(visit_date);
CREATE INDEX idx_visits_agent_id ON visits(agent_id);

CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_client_id ON payments(client_id);
CREATE INDEX idx_payments_created_at ON payments(created_at DESC);

CREATE INDEX idx_tickets_status ON support_tickets(status);
CREATE INDEX idx_tickets_priority ON support_tickets(priority);
CREATE INDEX idx_tickets_assigned_to ON support_tickets(assigned_to);

CREATE INDEX idx_notifications_status ON notifications(status);
CREATE INDEX idx_notifications_channel ON notifications(channel);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);

CREATE INDEX idx_documents_related ON documents(related_type, related_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

-- ─── AUTO-UPDATE updated_at ──────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'zones','internal_users','agents','clients','leads','lead_notes',
    'terrains','visits','payments','documents','support_tickets',
    'notification_templates'
  ] LOOP
    EXECUTE format('CREATE TRIGGER trg_updated_at_%s
      BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t, t);
  END LOOP;
END $$;