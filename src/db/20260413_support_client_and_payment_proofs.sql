-- =========================
-- SUPPORT CLIENT
-- =========================

ALTER TABLE support_tickets
ADD COLUMN IF NOT EXISTS source varchar(30) NOT NULL DEFAULT 'backoffice',
ADD COLUMN IF NOT EXISTS channel varchar(30) NOT NULL DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS category varchar(50),
ADD COLUMN IF NOT EXISTS last_message_at timestamptz,
ADD COLUMN IF NOT EXISTS unread_count_client integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS unread_count_support integer NOT NULL DEFAULT 0;

ALTER TABLE ticket_messages
ADD COLUMN IF NOT EXISTS sender_type varchar(20) NOT NULL DEFAULT 'internal_user',
ADD COLUMN IF NOT EXISTS client_id uuid NULL,
ADD COLUMN IF NOT EXISTS attachment_count integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS is_read_by_client boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS is_read_by_support boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  message_id uuid NULL REFERENCES ticket_messages(id) ON DELETE SET NULL,
  uploaded_by_type varchar(20) NOT NULL,
  uploaded_by_user_id uuid NULL,
  uploaded_by_client_id uuid NULL,
  file_url text NOT NULL,
  file_storage_key text NOT NULL,
  file_type varchar(50),
  size_bytes integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket_id
  ON ticket_attachments(ticket_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id
  ON ticket_messages(ticket_id, created_at ASC);

-- =========================
-- PAYMENT PROOFS
-- =========================

ALTER TABLE payments
ADD COLUMN IF NOT EXISTS reference_code varchar(100),
ADD COLUMN IF NOT EXISTS client_instruction_note text,
ADD COLUMN IF NOT EXISTS proof_status varchar(20) NOT NULL DEFAULT 'none';

CREATE TABLE IF NOT EXISTS payment_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'submitted',
  note text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  reviewed_by uuid NULL REFERENCES internal_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payment_proof_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_proof_id uuid NOT NULL REFERENCES payment_proofs(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  file_storage_key text NOT NULL,
  file_type varchar(50),
  size_bytes integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_proofs_payment_id
  ON payment_proofs(payment_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_proof_files_proof_id
  ON payment_proof_files(payment_proof_id, created_at ASC);

