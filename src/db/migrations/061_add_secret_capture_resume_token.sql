-- Up Migration
-- Specialist secret-capture resume (#995), follow-up to #972.
--
-- When a DELEGATED specialist mints a capture link, the resume must be routed through the
-- coordinator, which re-delegates to the specialist via the delegate skill's resume_token. This
-- column carries that base64 resume_token (agent + original task + progress/intent — names and NL
-- only, NEVER a secret value) so the redeem endpoint can publish it on secret.captured. Nullable:
-- a coordinator-minted link (today's only live path) leaves it NULL and resumes the agent directly.

ALTER TABLE secret_capture_tokens
  ADD COLUMN resume_token TEXT;        -- base64 delegate resume_token; NULL for coordinator-minted links

-- Down Migration

ALTER TABLE secret_capture_tokens
  DROP COLUMN resume_token;
