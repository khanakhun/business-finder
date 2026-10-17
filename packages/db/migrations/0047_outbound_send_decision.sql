-- BF-052 part 2: each send attempt is judged again, so the send-stage decision may change while the message is
-- still on its way (queued, sending, failed). Once it is sent or blocked, its decisions are evidence and fixed.
CREATE OR REPLACE FUNCTION bf_outbound_decisions_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.enqueue_decision_id IS NOT NULL AND NEW.enqueue_decision_id IS DISTINCT FROM OLD.enqueue_decision_id)
     OR (OLD.send_decision_id IS NOT NULL
         AND NEW.send_decision_id IS DISTINCT FROM OLD.send_decision_id
         AND OLD.status NOT IN ('queued', 'sending', 'failed')) THEN
    RAISE EXCEPTION 'outbound_messages: a compliance decision cannot be replaced' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
