// src/dispatch/outbound-context.ts
//
// Service class for the outbound context bridge registry. Owns all CRUD on the
// outbound_context table. The dispatcher uses the full service for inbound
// injection; send skills use a ScopedOutboundContext (narrow: register + release
// only) via the outboundContext capability.
//
// See docs/adr/019-delegation-aware-outbound-context.md.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

const MAX_PREVIEW_LENGTH = 300;
// Metadata carries structured delegation context (e.g. resume_tokens for
// multi-turn clarification). Postgres JSONB has no practical size limit;
// this cap is an application-level guard against unbounded LLM-generated
// metadata. 16 KB accommodates base64-encoded resume tokens with generous
// context fields while still preventing runaway payloads.
const MAX_METADATA_LENGTH = 16_000;
const MAX_FIELD_LENGTH = 500;

// ── Config ───────────────────────────────────────────────────────────────

/**
 * Built-in per-channel TTL defaults, keyed by channel id (#1816).
 *
 * A channel absent from this map falls through to `defaultExpiryHours`, so the
 * flat short window stays the rule and a longer window is the documented
 * exception. Only asynchronous channels belong here.
 *
 * Email earns 72h because its reply rhythm is business days, not hours: a
 * message sent late afternoon is routinely answered the next morning (~15h
 * later, well past the old 6h window), and a Friday-afternoon ask is answered
 * on Monday. 72h covers both without keeping entries alive for a full week.
 */
export const CHANNEL_DEFAULT_EXPIRY_HOURS: Readonly<Record<string, number>> = Object.freeze({
  email: 72,
});

/** Optional configuration for OutboundContextService TTL defaults. */
export interface OutboundContextConfig {
  /**
   * Hours until auto-registered entries expire on channels with no per-channel
   * default. Default: 6.
   */
  defaultExpiryHours?: number;
  /** Hours until entries with explicit context_bridge metadata expire. Default: 24. */
  explicitExpiryHours?: number;
  /**
   * Per-channel TTL overrides, keyed by channel id. Merged over
   * CHANNEL_DEFAULT_EXPIRY_HOURS, so naming a channel here replaces its
   * built-in value and naming a new one adds it.
   */
  channelDefaultExpiryHours?: Record<string, number>;
}

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
  /** Hours until automatic expiry. Default: the channel's default TTL (see
   *  CHANNEL_DEFAULT_EXPIRY_HOURS / defaultExpiryHoursFor). */
  expiresInHours?: number;
  /**
   * Which rule chose `expiresInHours`, for the registration log (#1816).
   *
   * Callers that resolve the TTL themselves must say so: the service cannot
   * tell an agent's deliberate window from one it supplied a line earlier, and
   * a guess here sends the next debugger looking at the wrong layer. Omitted
   * only by callers that let the service resolve the default.
   */
  ttlSource?: TtlSource;
}

/**
 * Provenance of a registered entry's TTL, ordered from most to least
 * deliberate. `agent` means a skill passed `expires_in_hours`; `task-wake` is
 * the system's 168h reply binding; `explicit-tier` is `explicitExpiryHours`
 * (or the channel default, whichever is longer); `channel-default` is bare
 * auto-registration.
 */
export type TtlSource = 'agent' | 'task-wake' | 'explicit-tier' | 'channel-default';

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

/** Result of a bulk clear-by-subject operation (see clearBySubjects). */
export interface SubjectClearResult {
  /** Total active entries released across all matched subjects. */
  totalReleased: number;
  /** Per-subject release counts — only subjects that matched ≥1 active entry. */
  perSubject: { subject: string; released: number }[];
  /** Requested subjects that matched zero active entries. */
  unmatched: string[];
}

/** Narrow interface exposed to skills via the outboundContext capability. */
export interface OutboundContextCapability {
  readonly defaultExpiryHours: number;
  readonly explicitExpiryHours: number;
  /** Auto-registration TTL for a given channel — the per-channel default, or
   *  `defaultExpiryHours` for channels with no entry (#1816). */
  defaultExpiryHoursFor(channelId: string): number;
  register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string>;
  release(entryId: string): Promise<void>;
  /** Release by entry id only — conversation-agnostic (task-wake bindings span channels). */
  releaseEntry(entryId: string): Promise<void>;
  /** Load one active entry by id (conversation-agnostic — for context-bridge-release). */
  getEntry(entryId: string): Promise<OutboundContextRow | null>;
  /** Release every active entry whose metadata subject matches one of `subjects`. */
  clearBySubjects(subjects: string[]): Promise<SubjectClearResult>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function truncatePreview(content: string): string {
  if (content.length <= MAX_PREVIEW_LENGTH) return content;
  return content.slice(0, MAX_PREVIEW_LENGTH) + '…';
}

/** Truncate optional text fields to avoid storing unexpectedly large values. */
function truncateField(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + '…';
}

/** Serialize metadata as JSON, dropping it entirely if oversized.
 *  Unlike text fields, JSONB cannot be truncated — a sliced JSON string is invalid. */
function serializeMetadata(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null;
  const json = JSON.stringify(metadata);
  if (json.length > MAX_METADATA_LENGTH) return null;
  return json;
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
  private readonly _defaultExpiryHours: number;
  private readonly _explicitExpiryHours: number;
  private readonly _channelDefaultExpiryHours: Readonly<Record<string, number>>;

  constructor(
    private pool: DbPool,
    private logger: Logger,
    config?: OutboundContextConfig,
  ) {
    this._defaultExpiryHours = config?.defaultExpiryHours ?? 6;
    this._explicitExpiryHours = config?.explicitExpiryHours ?? 24;
    // YAML overrides win per channel; unnamed channels keep their built-in value.
    this._channelDefaultExpiryHours = {
      ...CHANNEL_DEFAULT_EXPIRY_HOURS,
      ...(config?.channelDefaultExpiryHours ?? {}),
    };

    // info, not debug: prod runs at LOG_LEVEL=info, so a debug line would never
    // fire and the resolved policy would stay invisible in the one place it
    // matters — #1816 was diagnosed by reading a row by hand. One line per boot
    // (not per send) keeps that cheap, and it is also how a typo'd channel key
    // surfaces: an inert `emial: 96` shows up here next to a still-72 `email`.
    this.logger.info(
      {
        defaultExpiryHours: this._defaultExpiryHours,
        explicitExpiryHours: this._explicitExpiryHours,
        channelDefaults: this._channelDefaultExpiryHours,
      },
      'Outbound context TTL policy resolved',
    );
  }

  get defaultExpiryHours(): number {
    return this._defaultExpiryHours;
  }

  get explicitExpiryHours(): number {
    return this._explicitExpiryHours;
  }

  /**
   * Resolve the auto-registration TTL for a channel (#1816).
   *
   * Channels with a per-channel default (built-in or YAML) use it; everything
   * else falls through to `defaultExpiryHours`. Note the asymmetry: raising
   * `defaultExpiryHours` does NOT lower a channel that has its own entry —
   * the per-channel value is a deliberate statement about that channel's reply
   * rhythm, not a ceiling on the global knob.
   */
  defaultExpiryHoursFor(channelId: string): number {
    return this._channelDefaultExpiryHours[channelId] ?? this._defaultExpiryHours;
  }

  /** Write a new outbound context entry. Returns the generated UUID. */
  async register(entry: OutboundContextEntry): Promise<string> {
    const preview = truncatePreview(entry.content);
    // Resolved here as well as at the call site so that any caller which omits
    // expiresInHours still gets the channel-aware window rather than a flat 6h.
    // Trust the caller's own account of which rule chose the window; only fall
    // back to deriving it for callers that let the service resolve the default.
    const expiresInHours = entry.expiresInHours ?? this.defaultExpiryHoursFor(entry.channelId);
    const ttlSource: TtlSource =
      entry.ttlSource ?? (entry.expiresInHours != null ? 'agent' : 'channel-default');
    const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000);

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
        truncateField(entry.expectedReply, MAX_FIELD_LENGTH),
        truncateField(entry.delegationHint, MAX_FIELD_LENGTH),
        serializeMetadata(entry.metadata),
        expiresAt,
      ],
    );

    const id = result.rows[0]!.id;
    // Log the resolved window and where it came from — a silently-short TTL was
    // invisible in prod until someone read the row by hand (#1816).
    this.logger.debug(
      { id, channelId: entry.channelId, agentId: entry.agentId, expiresInHours, ttlSource },
      'Outbound context entry registered',
    );
    return id;
  }

  /**
   * Query active (non-released, non-expired) entries, newest first.
   *
   * Intentionally conversation-agnostic: proactive sends register under the
   * *invoking* conversation (bullpen thread id, scheduler run id, Signal peer),
   * while the reply often arrives on a different conversation id. Conversation
   * scoping therefore hides the bridge's primary correlation cases (#1817
   * review). Relevance filtering stays with the LLM over this bounded window.
   * `clearBySubjects()` is also conversation-agnostic for the same reason.
   */
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

  /** Load one active (non-released, non-expired) entry by id. Conversation-agnostic. */
  async getEntry(entryId: string): Promise<OutboundContextRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM outbound_context
       WHERE id = $1 AND released = false AND expires_at > now()`,
      [entryId],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /** Release by entry id only — conversation-agnostic (task-wake bindings span channels). */
  async releaseEntry(entryId: string): Promise<void> {
    return this.release(entryId);
  }

  /** Mark an entry as released — stop expecting replies. */
  async release(entryId: string, conversationId?: string): Promise<void> {
    const result = conversationId
      ? await this.pool.query(
          `UPDATE outbound_context SET released = true WHERE id = $1 AND conversation_id = $2`,
          [entryId, conversationId],
        )
      : await this.pool.query(
          `UPDATE outbound_context SET released = true WHERE id = $1`,
          [entryId],
        );
    if ((result.rowCount ?? 0) === 0) {
      this.logger.debug({ entryId, conversationId }, 'release() matched no rows — entry may have been cleaned up, already released, or belong to a different conversation');
    }
  }

  /**
   * Release every active (non-released, non-expired) entry whose metadata
   * `subject` equals one of the given subjects (exact, case-insensitive).
   *
   * Intentionally conversation-agnostic — unlike release(entryId), the subject
   * IS the scope. Debrief prompts and their replies can span Signal and email
   * (different conversation_ids), so scoping by conversation would miss entries.
   * It scans the whole active table, so entries that fell outside the
   * coordinator's bounded [ACTIVE OUTBOUND CONTEXT] injection window are still
   * released — this is the core of the #975 fix.
   *
   * Blank subjects are dropped and duplicates collapsed (case-insensitive). A
   * subject matching no active entry is returned in `unmatched` so callers can
   * report it instead of claiming a clear they cannot substantiate.
   */
  async clearBySubjects(subjects: string[]): Promise<SubjectClearResult> {
    // Normalize: trim, drop blanks, de-dup case-insensitively (preserve first casing).
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const s of subjects) {
      const trimmed = typeof s === 'string' ? s.trim() : '';
      if (trimmed.length === 0) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(trimmed);
    }

    const perSubject: { subject: string; released: number }[] = [];
    const unmatched: string[] = [];
    let totalReleased = 0;

    for (const subject of cleaned) {
      const result = await this.pool.query<{ id: string }>(
        `UPDATE outbound_context
           SET released = true
         WHERE released = false
           AND expires_at > now()
           AND lower(metadata->>'subject') = lower($1)
         RETURNING id`,
        [subject],
      );
      const released = result.rowCount ?? 0;
      if (released > 0) {
        perSubject.push({ subject, released });
        totalReleased += released;
      } else {
        unmatched.push(subject);
      }
    }

    this.logger.debug(
      { totalReleased, matched: perSubject.length, unmatched: unmatched.length },
      'clearBySubjects completed',
    );
    return { totalReleased, perSubject, unmatched };
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
        // Keep the key name `entry_id` (agents and context-bridge-release still
        // look for it) but make the id space unambiguous in the label (#1817).
        `entry_id (for context-bridge-release only — NOT a Nylas/email message id): ${e.id}`,
        `[sent ${timeAgo(e.createdAt)} via ${e.channelId}, on behalf of ${e.agentId}, expires in ${timeUntil(e.expiresAt)}]`,
        `preview: "${e.contentPreview.replace(/\n/g, ' ')}"`,
      ];
      if (e.expectedReply) lines.push(`expected reply: ${e.expectedReply}`);
      if (e.delegationHint) lines.push(`delegation: ${e.delegationHint}`);
      if (e.metadata) lines.push(`context: ${JSON.stringify(e.metadata)}`);
      lines.push('---');
      return lines.join('\n');
    });

    return [
      '[ACTIVE OUTBOUND CONTEXT — messages you\'ve sent that may receive replies]',
      'Each entry_id below is an outbound_context UUID for context-bridge-release only. Do not pass it as email-reply reply_to_message_id — that field needs a Nylas Message ID from the inbound email (e.g. the OWNER CC / Message ID preamble).',
      ...blocks,
      '',
      originalContent,
    ].join('\n');
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

/**
 * Strip the [ACTIVE OUTBOUND CONTEXT] preamble from a stored user message,
 * returning only the CEO's original text.
 *
 * The preamble produced by formatInjectionBlock always ends with a '---' line
 * on its own line followed by a blank line before the original content, giving
 * the separator '\n---\n\n'. Using the full newline-anchored pattern reduces
 * (though does not eliminate) the chance of a false match against user text
 * that contains triple-dashes — in practice, a CEO's chat message rarely
 * contains '\n---\n\n'. Returns content unchanged if no preamble is detected.
 */
export function stripOutboundContextPreamble(content: string): string {
  if (!content.startsWith('[ACTIVE OUTBOUND CONTEXT')) return content;
  const sep = '\n---\n\n';
  // Use indexOf (first occurrence) — the preamble's entry blocks always end with
  // '---' on its own line, so the FIRST '\n---\n\n' is always the boundary between
  // the last block and the original content. lastIndexOf would incorrectly split
  // at a markdown horizontal rule ('---') inside the user's own message.
  const idx = content.indexOf(sep);
  if (idx === -1) return content;
  return content.slice(idx + sep.length);
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

  get defaultExpiryHours(): number {
    return this.service.defaultExpiryHours;
  }

  get explicitExpiryHours(): number {
    return this.service.explicitExpiryHours;
  }

  defaultExpiryHoursFor(channelId: string): number {
    return this.service.defaultExpiryHoursFor(channelId);
  }

  async register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string> {
    return this.service.register({ ...entry, conversationId: this.conversationId });
  }

  async release(entryId: string): Promise<void> {
    return this.service.release(entryId, this.conversationId);
  }

  async releaseEntry(entryId: string): Promise<void> {
    return this.service.release(entryId);
  }

  async getEntry(entryId: string): Promise<OutboundContextRow | null> {
    return this.service.getEntry(entryId);
  }

  async clearBySubjects(subjects: string[]): Promise<SubjectClearResult> {
    // Intentionally conversation-agnostic — see OutboundContextService.clearBySubjects.
    // The subject is the scope, not this.conversationId, so we delegate without scoping.
    return this.service.clearBySubjects(subjects);
  }
}
