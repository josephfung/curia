// llm-call-archive.ts — redact + persist full llm.call prompts/responses.
//
// Spec 10: archive rows are written in the SAME transaction as the audit_log
// INSERT for the llm.call event. Emitters attach content via the typed
// `archive` field on LlmCallEvent (never in payload / never hashed).
//
// Redaction policy: if redaction throws, skip the archive write (never store
// unredacted content) but still write the audit_log row (hashes only).

import type { Pool, PoolClient } from 'pg';
import type { LlmCallArchiveContent } from '../bus/events.js';
import type { Logger } from '../logger.js';
import { scrubPii } from '../pii/scrubber.js';
import { createSecretPatterns } from '../security/secret-patterns.js';

export type { LlmCallArchiveContent };

/** Sensitive JSON key names (case-insensitive) whose values become [REDACTED]. */
const SENSITIVE_KEY_RE =
  /^(password|passwd|token|secret|api_key|apikey|authorization|auth|credential|private_key)$/i;

/**
 * Redact secrets + PII from archive JSON. Throws on failure so the caller can
 * skip the archive write rather than store unredacted content.
 *
 * Note: the shared long-hex pattern is deliberately aggressive — it redacts any
 * 32+ lowercase-hex run (dash-less UUIDs, git SHAs, pasted hashes). Acceptable
 * for a lossy provenance archive; do not narrow without an allowlist strategy.
 */
export function redactArchiveContent(value: unknown): unknown {
  return walkRedact(value, createSecretPatterns());
}

function walkRedact(node: unknown, secretPatterns: RegExp[]): unknown {
  if (typeof node === 'string') {
    return redactString(node, secretPatterns);
  }
  if (Array.isArray(node)) {
    return node.map((item) => walkRedact(item, secretPatterns));
  }
  if (node !== null && typeof node === 'object') {
    // Reject non-plain objects (Buffer, Date, circular class instances) — they
    // are not valid archive JSON and indicate malformed content.
    if (Object.getPrototypeOf(node) !== Object.prototype) {
      throw new Error(
        `llm_call_archive redaction: non-plain object (${Object.prototype.toString.call(node)})`,
      );
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = walkRedact(val, secretPatterns);
      }
    }
    return out;
  }
  // numbers, booleans, null
  return node;
}

function redactString(text: string, secretPatterns: RegExp[]): string {
  let result = text;
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return scrubPii(result);
}

/**
 * INSERT a redacted archive row on the given client (must be inside the caller's
 * transaction with the matching audit_log INSERT). Returns false when redaction
 * failed and the archive write was skipped.
 */
export async function writeLlmCallArchive(
  client: PoolClient,
  auditEventId: string,
  content: LlmCallArchiveContent,
  logger: Logger,
): Promise<boolean> {
  let prompt: unknown;
  let response: unknown;
  let toolDefinitions: unknown = null;

  try {
    prompt = redactArchiveContent(content.prompt);
    response = redactArchiveContent(content.response);
    if (content.toolDefinitions !== undefined) {
      toolDefinitions = redactArchiveContent(content.toolDefinitions);
    }
  } catch (err) {
    logger.error(
      { err, eventId: auditEventId },
      'llm_call_archive redaction failed — skipping archive write (audit row still written)',
    );
    return false;
  }

  // JSON.stringify(undefined) is JS undefined → node-pg binds SQL NULL, which
  // violates prompt/response NOT NULL and would roll back the audit_log row too.
  // Skip the archive (same fail-closed posture as redaction failure) instead.
  if (prompt === undefined || response === undefined) {
    logger.error(
      { eventId: auditEventId, promptDefined: prompt !== undefined, responseDefined: response !== undefined },
      'llm_call_archive missing prompt/response after redaction — skipping archive write (audit row still written)',
    );
    return false;
  }

  try {
    await client.query(
      `INSERT INTO llm_call_archive (audit_event_id, prompt, response, tool_definitions)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)`,
      [
        auditEventId,
        JSON.stringify(prompt),
        JSON.stringify(response),
        toolDefinitions === null ? null : JSON.stringify(toolDefinitions),
      ],
    );
    return true;
  } catch (err) {
    // Let the caller roll back the whole transaction — orphaned audit without
    // archive (or vice versa) violates the atomicity guarantee.
    logger.error({ err, eventId: auditEventId }, 'llm_call_archive INSERT failed');
    throw err;
  }
}

/**
 * Delete archive rows older than `retentionDays`. Bound the plaintext store —
 * data never written (or already purged) cannot leak. Called from DreamEngine.
 *
 * Deletes in batches of 1000 so a large backlog cannot lock `llm_call_archive`
 * (and bloat WAL) for one enormous transaction.
 */
export async function purgeExpiredLlmCallArchive(
  pool: Pool,
  retentionDays: number,
  logger: Logger,
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`purgeExpiredLlmCallArchive: retentionDays must be a positive integer, got ${retentionDays}`);
  }
  const BATCH = 1000;
  let total = 0;
  try {
    for (;;) {
      const result = await pool.query(
        `DELETE FROM llm_call_archive
         WHERE audit_event_id IN (
           SELECT audit_event_id FROM llm_call_archive
           WHERE created_at < now() - ($1::text || ' days')::interval
           LIMIT $2
         )`,
        [String(retentionDays), BATCH],
      );
      const n = result.rowCount ?? 0;
      total += n;
      if (n < BATCH) break;
    }
    return total;
  } catch (err) {
    logger.error({ err, retentionDays, purgedSoFar: total }, 'llm_call_archive purge failed');
    throw err;
  }
}
