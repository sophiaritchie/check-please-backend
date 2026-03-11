-- Add send_after column to support scheduled/delayed message delivery
ALTER TABLE messages
  ADD COLUMN send_after TIMESTAMPTZ;

-- Update queue index to include send_after filtering
DROP INDEX IF EXISTS idx_messages_queue;
CREATE INDEX idx_messages_queue
  ON messages (message_status, priority DESC, queued_at ASC)
  WHERE message_status IN ('queued', 'sending', 'pending', 'failed', 'undelivered');
