-- Enable pgAudit extension.
-- This script runs once on first database initialization (via /docker-entrypoint-initdb.d/).
-- pgAudit must already be loaded via shared_preload_libraries (set in compose command args).
--
-- All pgaudit.* runtime settings (log, log_parameter, log_relation, role) are configured
-- via compose command args, not ALTER SYSTEM. This keeps configuration in one place.
--
-- NOTE: pgaudit.log_parameter=on (set in compose) logs actual SQL bind parameter values.
-- This may include user messages, email content, or PII. Ensure the Postgres log destination
-- is secured appropriately. In production, consider disabling this or restricting log access.
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- Create the audit role used for object-level auditing.
-- Granting SELECT/INSERT/UPDATE/DELETE on specific tables to this role causes
-- pgAudit to log all matching statements, regardless of which user executes them.
-- The role is referenced by pgaudit.role (set in compose command args).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgaudit_role') THEN
    CREATE ROLE pgaudit_role NOLOGIN;
  END IF;
END
$$;

-- After the audit_log table is created by Curia's migrations, run:
--   GRANT ALL ON audit_log TO pgaudit_role;
-- This tells pgAudit to log every SQL statement that touches audit_log,
-- providing a DB-level tamper detection layer independent of the application.
--
-- We don't grant here because the table doesn't exist yet (migrations run at app startup).
-- Run the GRANT manually after the first successful migration, or add it as a
-- post-migration step in the application bootstrap.
