-- 131_google_workspace_signin_states.sql
--
-- Single-use OAuth `state` values for "Sign in as Curia" with Google Workspace (#2683). The
-- console mints one per click; Google echoes it back to the public callback, which claims it
-- once. The raw state lives only in the Google redirect; this table keeps its sha256 hash, plus
-- the PKCE code verifier the callback must send with the code. The verifier is useless without
-- the authorization code, which never touches the database.

-- Up Migration

CREATE TABLE google_workspace_signin_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS google_workspace_signin_states;
