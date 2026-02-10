-- Only trigger SF update on 'delivered', not 'sent'
CREATE OR REPLACE FUNCTION notify_salesforce_update()
RETURNS TRIGGER AS $$
DECLARE
  project_url TEXT;
  svc_key TEXT;
BEGIN
  IF NEW.message_status = 'delivered'
    AND (OLD.message_status IS NULL OR OLD.message_status != 'delivered')
  THEN
    SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
    SELECT decrypted_secret INTO svc_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

    PERFORM net.http_post(
      url := project_url || '/functions/v1/update-salesforce',
      body := jsonb_build_object('message_id', NEW.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || svc_key,
        'apikey', svc_key
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
