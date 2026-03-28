# Extends the pgvector image with pgAudit for SQL-level audit logging.
# pgAudit captures INSERT/UPDATE/DELETE/DDL statements at the database level,
# providing a tamper-independent audit trail alongside Curia's application-level
# audit_log table. See docs/specs/10-audit-log-hardening.md.
FROM pgvector/pgvector:pg16

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgaudit \
    && rm -rf /var/lib/apt/lists/*
