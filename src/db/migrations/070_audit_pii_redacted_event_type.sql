-- #453: standardize PII redaction audit event type to underscore form.
-- Pre-fix rows used outbound.pii-redacted (hyphen).

UPDATE audit_log
SET event_type = 'outbound.pii_redacted'
WHERE event_type = 'outbound.pii-redacted';
