-- Add DEGRADED_MODE to call_events event_type constraint
BEGIN;

ALTER TABLE call_events DROP CONSTRAINT IF EXISTS call_events_event_type_check;

ALTER TABLE call_events ADD CONSTRAINT call_events_event_type_check CHECK (
  event_type IN (
    'TURN_INGESTED',
    'MEMORY_SYNCD',
    'TOOL_SELECTED',
    'EXECUTION_FROZEN',
    'TOOL_EXECUTION_STARTED',
    'TOOL_EXECUTION_COMPLETED',
    'VALIDATION_RESULT',
    'DEGRADED_MODE',
    'RESPONSE_SENT'
  )
);

COMMIT;
