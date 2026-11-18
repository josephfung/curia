-- 128_principal_originator_authenticated.sql
--
-- A principal originator carries the principal's authority only when the inbound that started
-- it authenticated the sender (`authenticated: true`, GHSA-p49r-jqh2-v668). A missing flag now
-- fails closed, so this makes the flag explicit on every stored principal originator: the ones
-- written before #2312 added it (2026-10-26), and the ones makePrincipalOriginator wrote
-- without it.
--
--   - Missing, on a channel that authenticates the sender (Signal, Slack, the web console, the
--     console, the local CLI, voice): true.
--   - Missing, on any other channel (email, whose SPF/DKIM/DMARC result was never recorded on
--     these rows, SMS, anything unknown, or no channel at all): false. Fail closed; the
--     principal re-creates a job that should keep its authority. COALESCE keeps a missing
--     channel from nulling the whole originator (jsonb_set is strict).
--   - Voice, web or CLI stored as false: true. #2312 stamped these false (voice until
--     2026-11-16, web until 2026-11-16, CLI until this change), though each authenticates the
--     sender: production has had no voice transport but the console and Signal calls, the web
--     console is principal-only behind its login, and the CLI runs on the host.
--
-- Rows that already say true or false are otherwise left as they are. Each table is a stored
-- originator a later turn reads back: a scheduled job's wake, a task, a bullpen thread, a
-- pending delegation's resolution, a secret capture's resume, and an outreach row's link.

-- Up Migration

UPDATE scheduled_jobs SET originator = jsonb_set(originator, '{authenticated}',
    to_jsonb(COALESCE(originator->>'channel' IN ('signal', 'slack', 'web', 'console', 'cli', 'voice'), false)))
  WHERE originator->>'systemRole' = 'principal' AND NOT (originator ? 'authenticated');
UPDATE scheduled_jobs SET originator = jsonb_set(originator, '{authenticated}', 'true'::jsonb)
  WHERE originator->>'systemRole' = 'principal' AND originator->>'channel' IN ('voice', 'web', 'cli')
    AND originator->'authenticated' = 'false'::jsonb;

UPDATE tasks SET originator = jsonb_set(originator, '{authenticated}',
    to_jsonb(COALESCE(originator->>'channel' IN ('signal', 'slack', 'web', 'console', 'cli', 'voice'), false)))
  WHERE originator->>'systemRole' = 'principal' AND NOT (originator ? 'authenticated');
UPDATE tasks SET originator = jsonb_set(originator, '{authenticated}', 'true'::jsonb)
  WHERE originator->>'systemRole' = 'principal' AND originator->>'channel' IN ('voice', 'web', 'cli')
    AND originator->'authenticated' = 'false'::jsonb;

UPDATE bullpen_threads SET originator = jsonb_set(originator, '{authenticated}',
    to_jsonb(COALESCE(originator->>'channel' IN ('signal', 'slack', 'web', 'console', 'cli', 'voice'), false)))
  WHERE originator->>'systemRole' = 'principal' AND NOT (originator ? 'authenticated');
UPDATE bullpen_threads SET originator = jsonb_set(originator, '{authenticated}', 'true'::jsonb)
  WHERE originator->>'systemRole' = 'principal' AND originator->>'channel' IN ('voice', 'web', 'cli')
    AND originator->'authenticated' = 'false'::jsonb;

UPDATE pending_delegations SET originator = jsonb_set(originator, '{authenticated}',
    to_jsonb(COALESCE(originator->>'channel' IN ('signal', 'slack', 'web', 'console', 'cli', 'voice'), false)))
  WHERE originator->>'systemRole' = 'principal' AND NOT (originator ? 'authenticated');
UPDATE pending_delegations SET originator = jsonb_set(originator, '{authenticated}', 'true'::jsonb)
  WHERE originator->>'systemRole' = 'principal' AND originator->>'channel' IN ('voice', 'web', 'cli')
    AND originator->'authenticated' = 'false'::jsonb;

UPDATE secret_capture_tokens SET originator = jsonb_set(originator, '{authenticated}',
    to_jsonb(COALESCE(originator->>'channel' IN ('signal', 'slack', 'web', 'console', 'cli', 'voice'), false)))
  WHERE originator->>'systemRole' = 'principal' AND NOT (originator ? 'authenticated');
UPDATE secret_capture_tokens SET originator = jsonb_set(originator, '{authenticated}', 'true'::jsonb)
  WHERE originator->>'systemRole' = 'principal' AND originator->>'channel' IN ('voice', 'web', 'cli')
    AND originator->'authenticated' = 'false'::jsonb;

UPDATE task_outreach SET originator = jsonb_set(originator, '{authenticated}',
    to_jsonb(COALESCE(originator->>'channel' IN ('signal', 'slack', 'web', 'console', 'cli', 'voice'), false)))
  WHERE originator->>'systemRole' = 'principal' AND NOT (originator ? 'authenticated');
UPDATE task_outreach SET originator = jsonb_set(originator, '{authenticated}', 'true'::jsonb)
  WHERE originator->>'systemRole' = 'principal' AND originator->>'channel' IN ('voice', 'web', 'cli')
    AND originator->'authenticated' = 'false'::jsonb;

-- Down Migration

-- Nothing to undo: the rows had no flag, not a different one, and a principal originator
-- without the flag has no authority either way.
