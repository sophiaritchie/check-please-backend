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

-- 2. Relax constraints for queue-time inserts (values not known until send)
ALTER TABLE messages
  ALTER COLUMN dialpad_id DROP NOT NULL;

-- Drop the unique constraint on dialpad_id
ALTER TABLE messages
  DROP CONSTRAINT messages_dialpad_id_key;

ALTER TABLE messages
  ALTER COLUMN contact_id DROP NOT NULL;

ALTER TABLE messages
  ALTER COLUMN direction DROP NOT NULL,
  ALTER COLUMN direction SET DEFAULT 'outbound';

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
