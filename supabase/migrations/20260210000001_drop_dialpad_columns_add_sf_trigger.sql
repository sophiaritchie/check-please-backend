-- ============================================================
-- Drop Dialpad-response columns from messages (now in send_attempts)
-- Add SF update trigger
-- ============================================================

-- 1. Drop columns that now live exclusively in send_attempts
ALTER TABLE messages
  DROP COLUMN IF EXISTS dialpad_id,
  DROP COLUMN IF EXISTS contact_id,
  DROP COLUMN IF EXISTS device_type,
  DROP COLUMN IF EXISTS direction,
  DROP COLUMN IF EXISTS target_id,
  DROP COLUMN IF EXISTS target_type;

-- 2. Trigger: call update-salesforce edge function when message reaches sent/delivered
CREATE OR REPLACE FUNCTION notify_salesforce_update()
RETURNS TRIGGER AS $$
DECLARE
  edge_function_url TEXT;
  service_role_key TEXT;
BEGIN
  IF NEW.message_status IN ('sent', 'delivered')
    AND (OLD.message_status IS NULL OR OLD.message_status NOT IN ('sent', 'delivered'))
  THEN
    edge_function_url := current_setting('app.settings.supabase_url', true) || '/functions/v1/update-salesforce';
    service_role_key := current_setting('app.settings.service_role_key', true);

    PERFORM net.http_post(
      url := edge_function_url,
      body := jsonb_build_object('message_id', NEW.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_role_key,
        'apikey', service_role_key
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_salesforce_update
  AFTER UPDATE OF message_status ON messages
  FOR EACH ROW
  EXECUTE FUNCTION notify_salesforce_update();
