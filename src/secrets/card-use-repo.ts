/**
 * CardUseRepo — requests to use a saved card on a site, and the bounded grants they become
 * (#1358, ADR-027).
 *
 * One approval covers up to MAX_FILLS number fills and MAX_FILLS CVV fills on the approved
 * site's registrable domain, within one conversation, for 30 minutes. Every time window is
 * measured on the database clock (now()) so the app clock can't drift a grant open, and so
 * tests can back-date rows in SQL. Counters are bumped with a conditional UPDATE, so
 * concurrent fills can never exceed the cap.
 */

import type { DbPool } from '../db/connection.js';
import { registrableDomain } from '../verification/domain.js';
import type { CaptureOrigin } from './secret-capture-service.js';

const MAX_FILLS = 2;

export type CardUseStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface CardUseRequestRow {
  id: string;
  secretName: string;
  last4: string;
  siteDomain: string;
  conversationId: string;
  taskId: string;
  amount: string;
  purpose: string;
  origin: CaptureOrigin;
  status: CardUseStatus;
  approvalShortRef: string | null;
  createdAt: Date;
  approvedAt: Date | null;
}

interface DbRow {
  id: string;
  secret_name: string;
  last4: string;
  site_domain: string;
  conversation_id: string;
  task_id: string;
  amount: string;
  purpose: string;
  origin: CaptureOrigin;
  status: CardUseStatus;
  approval_short_ref: string | null;
  created_at: Date;
  approved_at: Date | null;
}

export class CardUseRepo {
  constructor(private readonly pool: DbPool) {}

  async create(r: {
    secretName: string;
    /** The card's last four now; a grant only fills a card that still ends in them. */
    last4: string;
    siteUrl: string;
    conversationId: string;
    taskId: string;
    amount: string;
    purpose: string;
    origin: CaptureOrigin;
  }): Promise<{ id: string; siteDomain: string }> {
    const siteDomain = registrableDomain(r.siteUrl);
    if (siteDomain === null) {
      throw new Error('card use request: site has no registrable domain');
    }
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO card_use_requests
         (secret_name, last4, site_domain, conversation_id, task_id, amount, purpose, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [r.secretName, r.last4, siteDomain, r.conversationId, r.taskId, r.amount, r.purpose, JSON.stringify(r.origin)],
    );
    return { id: result.rows[0]!.id, siteDomain };
  }

  async setShortRef(id: string, shortRef: string): Promise<void> {
    await this.pool.query(`UPDATE card_use_requests SET approval_short_ref = $2 WHERE id = $1`, [id, shortRef]);
  }

  async get(id: string): Promise<CardUseRequestRow | null> {
    const result = await this.pool.query<DbRow>(
      `SELECT id, secret_name, last4, site_domain, conversation_id, task_id, amount, purpose, origin,
              status, approval_short_ref, created_at, approved_at
         FROM card_use_requests WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      secretName: row.secret_name,
      last4: row.last4,
      siteDomain: row.site_domain,
      conversationId: row.conversation_id,
      taskId: row.task_id,
      amount: row.amount,
      purpose: row.purpose,
      origin: row.origin,
      status: row.status,
      approvalShortRef: row.approval_short_ref,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
    };
  }

  /** pending -> approved if still inside 30 minutes of creation; a stale pending row expires. */
  async approve(id: string): Promise<'approved' | 'expired' | 'already_resolved'> {
    const approved = await this.pool.query(
      `UPDATE card_use_requests SET status = 'approved', approved_at = now()
        WHERE id = $1 AND status = 'pending' AND created_at > now() - interval '30 minutes'
        RETURNING id`,
      [id],
    );
    if (approved.rowCount === 1) return 'approved';
    const expired = await this.pool.query(
      `UPDATE card_use_requests SET status = 'expired'
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [id],
    );
    return expired.rowCount === 1 ? 'expired' : 'already_resolved';
  }

  /** Resolve a pending request as denied or expired; false when it was no longer pending. */
  async decide(id: string, status: 'denied' | 'expired'): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE card_use_requests SET status = $2 WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id, status],
    );
    return result.rowCount === 1;
  }

  /**
   * Spend one fill against the newest live grant for this card (name and last four),
   * conversation and site.
   * `field` null is a public field (brand, expiry, ...): it needs a grant but isn't counted.
   */
  async consumeFill(q: {
    secretName: string;
    last4: string;
    siteUrl: string;
    conversationId: string;
    field: 'number' | 'cvv' | null;
  }): Promise<'ok' | 'no_grant' | 'fill_limit'> {
    const siteDomain = registrableDomain(q.siteUrl);
    if (siteDomain === null) return 'no_grant';
    const grant = await this.pool.query<{ id: string }>(
      `SELECT id FROM card_use_requests
        WHERE secret_name = $1 AND last4 = $4 AND conversation_id = $2 AND site_domain = $3
          AND status = 'approved' AND approved_at > now() - interval '30 minutes'
        ORDER BY approved_at DESC
        LIMIT 1`,
      [q.secretName, q.conversationId, siteDomain, q.last4],
    );
    const grantId = grant.rows[0]?.id;
    if (grantId === undefined) return 'no_grant';
    if (q.field === null) return 'ok';

    // Column name comes from a closed two-value union, never from caller input.
    const column = q.field === 'number' ? 'number_fills' : 'cvv_fills';
    const bumped = await this.pool.query(
      `UPDATE card_use_requests SET ${column} = ${column} + 1
        WHERE id = $1 AND ${column} < ${MAX_FILLS}
        RETURNING id`,
      [grantId],
    );
    return bumped.rowCount === 1 ? 'ok' : 'fill_limit';
  }
}
