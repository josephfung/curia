// src/verification/verification-service.ts
//
// Owns all reads and writes on the verifications table (#2017). One pending row
// per site (partial unique index): opening a second returns the existing one.
// The code value is never stored here, logged or put in an error.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { registrableDomain } from './domain.js';
import type {
  OpenVerificationInput,
  Verification,
  VerificationConfig,
  VerificationDelivery,
  VerificationKind,
  VerificationPurpose,
  VerificationStatus,
} from './types.js';

const PG_UNIQUE_VIOLATION = '23505';

interface VerificationRow {
  id: string;
  purpose: VerificationPurpose;
  kind: VerificationKind;
  delivery: VerificationDelivery;
  site: string;
  page_domain: string;
  browser_session_id: string;
  task_id: string | null;
  conversation_id: string | null;
  status: VerificationStatus;
  requested_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
  metadata: Record<string, unknown>;
}

const COLUMNS = `id, purpose, kind, delivery, site, page_domain, browser_session_id, task_id,
  conversation_id, status, requested_at, expires_at, resolved_at, metadata`;

function toVerification(row: VerificationRow): Verification {
  return {
    id: row.id,
    purpose: row.purpose,
    kind: row.kind,
    delivery: row.delivery,
    site: row.site,
    pageDomain: row.page_domain,
    browserSessionId: row.browser_session_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    metadata: row.metadata,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION;
}

export class VerificationService {
  constructor(
    private readonly pool: DbPool,
    private readonly logger: Logger,
    readonly config: VerificationConfig,
  ) {}

  /**
   * Open a verification, or reuse the site's existing pending one (`reused: true`),
   * refreshed to the caller's browser session, page domain, delivery and expiry. A pending row already
   * past its expiry is persisted as expired first, so a fresh sign-in attempt gets a
   * fresh record instead of a dead one.
   */
  async open(input: OpenVerificationInput): Promise<{ verification: Verification; reused: boolean }> {
    const site = registrableDomain(input.site);
    if (site === null) {
      throw new Error('Cannot open a verification: site has no registrable domain');
    }
    const pageDomain = registrableDomain(input.pageDomain);
    if (pageDomain === null) {
      throw new Error('Cannot open a verification: pageDomain has no registrable domain');
    }

    const requestedAt = new Date();
    const expiresAt = input.expiresAt ?? new Date(requestedAt.getTime() + this.config.defaultExpiryMinutes * 60_000);

    await this.expireStaleForSite(site, requestedAt);

    try {
      const { rows } = await this.pool.query<VerificationRow>(
        `INSERT INTO verifications
           (purpose, kind, delivery, site, page_domain, browser_session_id, task_id,
            conversation_id, requested_at, expires_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${COLUMNS}`,
        [
          input.purpose,
          input.kind,
          input.delivery,
          site,
          pageDomain,
          input.browserSessionId,
          input.taskId ?? null,
          input.conversationId ?? null,
          requestedAt,
          expiresAt,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      const verification = toVerification(rows[0]!);
      this.logger.info(
        { verificationId: verification.id, site, pageDomain, delivery: verification.delivery },
        'Verification opened',
      );
      return { verification, reused: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }

    // Unique violation: another pending row exists for this site. Reuse it, pointed at the
    // caller's session and page: the stored session may have died (a restart, an expired
    // session) and the code-entry page may now sit on another registrable domain (an
    // identity provider). Keeping the old values would show a dead session as the one to
    // type into and key the browser guard on the wrong domain. Delivery and expiry follow
    // the caller too: a reopen after "the email never came, send it by text instead" is an
    // SMS verification with a fresh code window, and the dispatcher only extracts codes from
    // the principal's messages for sms/app rows. A missing task or conversation link is
    // filled; an existing one is kept.
    const { rows } = await this.pool.query<VerificationRow>(
      `UPDATE verifications
         SET browser_session_id = $2,
             page_domain = $3,
             task_id = COALESCE(task_id, $4),
             conversation_id = COALESCE(conversation_id, $5),
             delivery = $6,
             expires_at = $7
       WHERE site = $1 AND status = 'pending'
       RETURNING ${COLUMNS}`,
      [
        site,
        input.browserSessionId,
        pageDomain,
        input.taskId ?? null,
        input.conversationId ?? null,
        input.delivery,
        expiresAt,
      ],
    );
    const existing = rows[0];
    if (!existing) {
      // The pending row closed between the failed insert and this update. Surface it
      // rather than loop; the caller's next turn opens a fresh record.
      throw new Error('Verification for this site changed while opening; retry');
    }
    this.logger.info(
      { verificationId: existing.id, site, pageDomain, delivery: existing.delivery },
      'Verification reused',
    );
    return { verification: toVerification(existing), reused: true };
  }

  async get(id: string): Promise<Verification | null> {
    const { rows } = await this.pool.query<VerificationRow>(
      `SELECT ${COLUMNS} FROM verifications WHERE id = $1`,
      [id],
    );
    return rows[0] ? toVerification(rows[0]) : null;
  }

  /**
   * Close a verification as satisfied or abandoned. A pending row closes, and so does
   * an expired one (a late code can still work; expiry is a hint, not a cliff). A row
   * already satisfied or abandoned is returned unchanged. Null when the id is unknown.
   */
  async close(id: string, status: 'satisfied' | 'abandoned'): Promise<Verification | null> {
    const { rows } = await this.pool.query<VerificationRow>(
      `UPDATE verifications SET status = $2, resolved_at = $3
       WHERE id = $1 AND status IN ('pending', 'expired')
       RETURNING ${COLUMNS}`,
      [id, status, new Date()],
    );
    if (rows[0]) {
      this.logger.info({ verificationId: id, status }, 'Verification closed');
      return toVerification(rows[0]);
    }
    return this.get(id);
  }

  /**
   * Pending verifications plus those closed within `recentWindowMinutes`, newest
   * first. Pending rows past their expiry are persisted as expired first, with
   * `resolved_at` at the expiry time, and still returned (marked expired).
   */
  async listActive(now: Date = new Date()): Promise<Verification[]> {
    await this.pool.query(
      `UPDATE verifications SET status = 'expired', resolved_at = expires_at
       WHERE status = 'pending' AND expires_at <= $1`,
      [now],
    );
    const windowStart = new Date(now.getTime() - this.config.recentWindowMinutes * 60_000);
    const { rows } = await this.pool.query<VerificationRow>(
      `SELECT ${COLUMNS} FROM verifications
       WHERE status = 'pending' OR resolved_at > $1
       ORDER BY requested_at DESC`,
      [windowStart],
    );
    return rows.map(toVerification);
  }

  async pendingForTask(taskId: string): Promise<Verification | null> {
    const { rows } = await this.pool.query<VerificationRow>(
      `SELECT ${COLUMNS} FROM verifications
       WHERE task_id = $1 AND status = 'pending'
       ORDER BY requested_at DESC
       LIMIT 1`,
      [taskId],
    );
    return rows[0] ? toVerification(rows[0]) : null;
  }

  private async expireStaleForSite(site: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE verifications SET status = 'expired', resolved_at = expires_at
       WHERE site = $1 AND status = 'pending' AND expires_at <= $2`,
      [site, now],
    );
  }
}
