-- Enable pgAudit extension.
-- This script runs once on first database initialization (via /docker-entrypoint-initdb.d/).
-- pgAudit must already be loaded via shared_preload_libraries (set in compose command args).
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- Create the audit role used for object-level auditing.
-- Granting SELECT/INSERT/UPDATE/DELETE on specific tables to this role causes
-- pgAudit to log all matching statements, regardless of which user executes them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgaudit_role') THEN
    CREATE ROLE pgaudit_role NOLOGIN;
  END IF;
END
$$;

-- Set the pgAudit role so object-level auditing is active.
ALTER SYSTEM SET pgaudit.role = 'pgaudit_role';

-- After the audit_log table is created by Curia's migrations, run:
--   GRANT ALL ON audit_log TO pgaudit_role;
-- This tells pgAudit to log every SQL statement that touches audit_log,
-- providing a DB-level tamper detection layer independent of the application.
--
-- We don't grant here because the table doesn't exist yet (migrations run at app startup).
-- See docker/postgres-grant-pgaudit.sql for a helper script, or run the GRANT manually
-- after the first successful migration.
SELECT pg_reload_conf();
