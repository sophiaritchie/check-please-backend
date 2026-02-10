-- ============================================================
-- Queue Architecture Migration
-- Adds queue columns to messages, creates send_attempts table
-- ============================================================

-- 1. Add new columns to messages
ALTER TABLE messages
  ADD COLUMN sf_id TEXT,
  ADD COLUMN sf_type TEXT,
  ADD COLUMN priority INTEGER DEFAULT 1,
  ADD COLUMN attempt_count INTEGER DEFAULT 0,
  ADD COLUMN queued_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN last_attempted_at TIMESTAMPTZ,
  ADD COLUMN failed_at TIMESTAMPTZ;

-- 2. Drop Dialpad-response columns (now live in send_attempts only)
ALTER TABLE messages
  DROP CONSTRAINT messages_dialpad_id_key;

ALTER TABLE messages
  DROP COLUMN dialpad_id,
  DROP COLUMN contact_id,
  DROP COLUMN device_type,
  DROP COLUMN direction,
  DROP COLUMN target_id,
  DROP COLUMN target_type;

ALTER TABLE messages
  ALTER COLUMN created_date SET DEFAULT NOW();

-- 3. Add queue processing index
CREATE INDEX idx_messages_queue
  ON messages (message_status, priority DESC, queued_at ASC)
  WHERE message_status IN ('queued', 'sending', 'pending', 'failed', 'undelivered');

-- 4. Create send_attempts table
CREATE TABLE send_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id),
  attempt_number INTEGER NOT NULL,
  dialpad_id TEXT UNIQUE,
  status TEXT DEFAULT 'sending',
  delivery_result TEXT,
  dialpad_contact_id TEXT,
  dialpad_created_date TIMESTAMPTZ,
  device_type TEXT,
  target_id TEXT,
  target_type TEXT,
  error_detail TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_send_attempts_message_id ON send_attempts(message_id);
CREATE INDEX idx_send_attempts_dialpad_id ON send_attempts(dialpad_id);

-- 5. RLS and permissions for send_attempts
ALTER TABLE send_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON send_attempts FROM anon, authenticated;
GRANT ALL ON send_attempts TO service_role;
