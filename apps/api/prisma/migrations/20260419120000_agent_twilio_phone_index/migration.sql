-- Faster lookup of inbound voice routing by Twilio "To" number (E.164).
DO $$
BEGIN
  IF to_regclass('"Agent"') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "Agent_twilioPhoneNumber_idx" ON "Agent"("twilioPhoneNumber");
  END IF;
END $$;
