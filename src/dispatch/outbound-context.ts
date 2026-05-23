// src/dispatch/outbound-context.ts
//
// Service class for the outbound context bridge registry. Owns all CRUD on the
// outbound_context table. The dispatcher uses the full service for inbound
// injection; send skills use a ScopedOutboundContext (narrow: register + release
// only) via the outboundContext capability.
//
// See docs/wip/2026-05-16-context-bridging-v2-design.md §2a.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

const MAX_PREVIEW_LENGTH = 300;
const DEFAULT_EXPIRY_HOURS = 24;

// ── Types ──────────────────────────────────────────────────────────────────

/** Input for registering a new outbound context entry. */
export interface OutboundContextEntry {
  conversationId: string;
  channelId: string;
  agentId: string;
  /** Full message content — truncated to MAX_PREVIEW_LENGTH for storage. */
  content: string;
  expectedReply?: string;
  delegationHint?: string;
  metadata?: Record<string, unknown>;
  /** Hours until automatic expiry. Default: 24. */
  expiresInHours?: number;
}

/** A row from the outbound_context table, with snake_case → camelCase mapping. */
export interface OutboundContextRow {
  id: string;
  conversationId: string;
  channelId: string;
  agentId: string;
  contentPreview: string;
  expectedReply: string | null;
  delegationHint: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  expiresAt: Date;
  released: boolean;
}

/** Narrow interface exposed to skills via the outboundContext capability. */
export interface OutboundContextCapability {
  register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string>;
  release(entryId: string): Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function truncatePreview(content: string): string {
  if (content.length <= MAX_PREVIEW_LENGTH) return content;
  return content.slice(0, MAX_PREVIEW_LENGTH) + '…';
}

/** Format a relative time-ago string for the injection block. */
function timeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Format a relative time-until string for the injection block. */
function timeUntil(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'expired';
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'less than 1h';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function mapRow(row: Record<string, unknown>): OutboundContextRow {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    channelId: row.channel_id as string,
    agentId: row.agent_id as string,
    contentPreview: row.content_preview as string,
    expectedReply: (row.expected_reply as string) ?? null,
    delegationHint: (row.delegation_hint as string) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? null,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    released: row.released as boolean,
  };
}

// ── Service ────────────────────────────────────────────────────────────────

export class OutboundContextService {
  constructor(
    private pool: DbPool,
    private logger: Logger,
  ) {}

  /** Write a new outbound context entry. Returns the generated UUID. */
  async register(entry: OutboundContextEntry): Promise<string> {
    const preview = truncatePreview(entry.content);
    const expiresAt = new Date(
      Date.now() + (entry.expiresInHours ?? DEFAULT_EXPIRY_HOURS) * 3_600_000,
    );

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO outbound_context
         (conversation_id, channel_id, agent_id, content_preview,
          expected_reply, delegation_hint, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        entry.conversationId,
        entry.channelId,
        entry.agentId,
        preview,
        entry.expectedReply ?? null,
        entry.delegationHint ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        expiresAt,
      ],
    );

    this.logger.debug({ id: result.rows[0].id, channelId: entry.channelId, agentId: entry.agentId }, 'Outbound context entry registered');
    return result.rows[0].id;
  }

  /** Query all active (non-released, non-expired) entries. */
  async getActive(limit = 10): Promise<OutboundContextRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM outbound_context
       WHERE released = false AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map(mapRow);
  }

  /** Mark an entry as released — stop expecting replies. */
  async release(entryId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE outbound_context SET released = true WHERE id = $1`,
      [entryId],
    );
    if ((result.rowCount ?? 0) === 0) {
      this.logger.debug({ entryId }, 'release() matched no rows — entry may have been cleaned up or already released');
    }
  }

  /** Delete expired or released entries. Returns the count of rows deleted. */
  async cleanupExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM outbound_context
       WHERE released = true OR expires_at <= now()`,
    );
    return result.rowCount ?? 0;
  }

  /**
   * Format the [ACTIVE OUTBOUND CONTEXT] injection block for the coordinator.
   * Returns null when there are no active entries (caller uses original content).
   */
  formatInjectionBlock(
    entries: OutboundContextRow[],
    originalContent: string,
  ): string | null {
    if (entries.length === 0) return null;

    const blocks = entries.map((e) => {
      const lines: string[] = [
        '---',
        `entry_id: ${e.id}`,
        `[sent ${timeAgo(e.createdAt)} via ${e.channelId}, on behalf of ${e.agentId}, expires in ${timeUntil(e.expiresAt)}]`,
        `preview: "${e.contentPreview}"`,
      ];
      if (e.expectedReply) lines.push(`expected reply: ${e.expectedReply}`);
      if (e.delegationHint) lines.push(`delegation: ${e.delegationHint}`);
      if (e.metadata) lines.push(`context: ${JSON.stringify(e.metadata)}`);
      lines.push('---');
      return lines.join('\n');
    });

    return [
      '[ACTIVE OUTBOUND CONTEXT — messages you\'ve sent that may receive replies]',
      ...blocks,
      '',
      originalContent,
    ].join('\n');
  }
}

// ── Scoped Wrapper ─────────────────────────────────────────────────────────

/**
 * Narrow capability surface injected into skills. Pre-scoped with
 * conversationId so skills don't need to know it.
 */
export class ScopedOutboundContext implements OutboundContextCapability {
  constructor(
    private service: OutboundContextService,
    private conversationId: string,
  ) {}

  async register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string> {
    return this.service.register({ ...entry, conversationId: this.conversationId });
  }

  async release(entryId: string): Promise<void> {
    return this.service.release(entryId);
  }
}
