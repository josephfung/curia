# Extends the pgvector image with pgAudit for SQL-level audit logging.
# pgAudit captures INSERT/UPDATE/DELETE/DDL statements at the database level,
# providing a tamper-independent audit trail alongside Curia's application-level
# audit_log table. See docs/specs/10-audit-log-hardening.md.
#
# Pinned by digest for a reproducible supply chain (clears the OpenSSF Scorecard
# Pinned-Dependencies Docker finding on this line). Tag kept inline so Dependabot's
# docker ecosystem (see .github/dependabot.yml) can read the pg16 version and bump
# the digest within the major. Re-resolve the digest when intentionally moving pg majors.
FROM pgvector/pgvector:pg16@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgaudit \
    && rm -rf /var/lib/apt/lists/*

# Startup verification script ensures pgAudit is correctly set up on every boot,
# not just on first init. Handles the existing-volume case where initdb.d scripts
# were skipped because the data directory already existed.
COPY docker/postgres-verify-pgaudit.sh /usr/local/bin/verify-pgaudit.sh

# Bake the pgAudit init script into the image so a source-free self-host stack
# (no repo checkout to volume-mount) still runs it on first DB init. The compose
# volume mount is removed in lockstep (see docker-compose.yml).
COPY docker/postgres-init-pgaudit.sql /docker-entrypoint-initdb.d/10-pgaudit.sql

# Setting ENTRYPOINT above resets the base image's `CMD ["postgres"]` to null, so
# without this the image would run `verify-pgaudit.sh` with no server command and
# never start Postgres. Restore the default. When the compose files provide their
# own `command:` (which starts with `postgres`), it replaces this CMD entirely and
# the wrapper receives `postgres -c ...` either way.
#
# The missing-USER finding anchors on this ENTRYPOINT line, so its suppression must
# live here (Semgrep only honours nosemgrep on the finding's own line or the line
# directly above). This is the intentional-root case justified below: the server
# drops to non-root `postgres` via gosu at runtime. Note the *entrypoint* rule id —
# distinct from the CMD-anchored `missing-user` variant suppressed further down.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["verify-pgaudit.sh"]
# No `USER` instruction is intentional. The Postgres entrypoint must start as root
# to run initdb and chown a fresh (root-owned) data volume on first boot, then it
# drops to the non-root `postgres` user via `gosu` to run the server itself
# (docker-entrypoint.sh: `exec gosu postgres ...`). Adding `USER postgres` here
# breaks first-time init on a fresh volume — the very failure #1350 fixes. So the
# running server is non-root despite the absence of a USER instruction; Semgrep's
# generic missing-user heuristic can't see the runtime gosu drop.
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["postgres"]
