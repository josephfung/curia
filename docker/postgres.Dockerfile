# Extends the pgvector image with pgAudit for SQL-level audit logging.
# pgAudit captures INSERT/UPDATE/DELETE/DDL statements at the database level,
# providing a tamper-independent audit trail alongside Curia's application-level
# audit_log table. See docs/specs/10-audit-log-hardening.md.
#
# Pinned by digest for a reproducible supply chain (clears the OpenSSF Scorecard
# Pinned-Dependencies Docker finding on this line). Tag kept inline so Dependabot's
# docker ecosystem (see .github/dependabot.yml) can read the pg16 version and bump
# the digest within the major. Re-resolve the digest when intentionally moving pg majors.
FROM pgvector/pgvector:pg16@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgaudit \
    && rm -rf /var/lib/apt/lists/*

# Startup verification script ensures pgAudit is correctly set up on every boot,
# not just on first init. Handles the existing-volume case where initdb.d scripts
# were skipped because the data directory already existed.
COPY docker/postgres-verify-pgaudit.sh /usr/local/bin/verify-pgaudit.sh
ENTRYPOINT ["verify-pgaudit.sh"]
