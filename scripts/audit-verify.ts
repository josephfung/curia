#!/usr/bin/env tsx
// scripts/audit-verify.ts
//
// Walk the audit_log hash chain from genesis and report the first broken link.
// Spec 10 / #1383 — offline integrity check (Phase 1: detects accidental /
// naive tampering; see docs/specs/10-audit-log-hardening.md Tamper Evidence).
//
// Run locally:  pnpm audit:verify
// Run on prod:  pnpm --prefix /opt/curia tsx --env-file=.env scripts/audit-verify.ts
//
// Exit codes: 0 = intact (or empty log), 1 = broken link / hash gap, 2 = usage/DB error.
//
// Pre-hardening rows (NULL entry_hash) cannot be backfilled — migration 021's
// append-only trigger blocks UPDATEs. NULL rows are skipped entirely; the hash
// chain is defined only over rows that have entry_hash. Order is the monotonic
// `seq` column (migration 080), not wall-clock timestamp.

import pg from 'pg';
import {
  GENESIS_HASH,
  computeEntryHash,
  toHashTimestamp,
  type HashChainFields,
} from '../src/audit/hash-chain.js';

const { Pool } = pg;

const PAGE_SIZE = 1000;

interface AuditVerifyRow {
  id: string;
  timestamp: Date;
  event_type: string;
  source_layer: string;
  source_id: string;
  payload: unknown;
  conversation_id: string | null;
  task_id: string | null;
  parent_event_id: string | null;
  action: string | null;
  outcome: string | null;
  target_type: string | null;
  target_id: string | null;
  initiator_type: string | null;
  initiator_id: string | null;
  entry_hash: string | null;
  seq: string;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is required. Add it to .env or set it in the environment.\n');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let previousHash = GENESIS_HASH;
  let checked = 0;
  let skippedNull = 0;
  let lastSeq = '0';

  try {
    const colCheck = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'audit_log' AND column_name = 'seq'
       ) AS exists`,
    );
    if (!colCheck.rows[0]?.exists) {
      process.stderr.write(
        'audit_log.seq column missing — run migrations (080_audit_log_chain_seq) first.\n',
      );
      process.exit(2);
    }

    for (;;) {
      // Keyset on seq — matches AuditLogger head SELECT / write order.
      const result = await pool.query<AuditVerifyRow>(
        `SELECT id, timestamp, event_type, source_layer, source_id, payload,
                conversation_id, task_id, parent_event_id,
                action, outcome, target_type, target_id,
                initiator_type, initiator_id, entry_hash, seq::text AS seq
         FROM audit_log
         WHERE seq > $1::bigint
         ORDER BY seq ASC
         LIMIT $2`,
        [lastSeq, PAGE_SIZE],
      );

      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        lastSeq = row.seq;

        if (row.entry_hash === null || row.entry_hash === '') {
          skippedNull += 1;
          continue;
        }

        checked += 1;

        const fields: HashChainFields = {
          id: row.id,
          timestamp: toHashTimestamp(row.timestamp),
          event_type: row.event_type,
          source_layer: row.source_layer,
          source_id: row.source_id,
          payload: row.payload,
          conversation_id: row.conversation_id,
          task_id: row.task_id,
          parent_event_id: row.parent_event_id,
          action: row.action,
          outcome: row.outcome,
          target_type: row.target_type,
          target_id: row.target_id,
          initiator_type: row.initiator_type,
          initiator_id: row.initiator_id,
        };

        const expected = computeEntryHash(fields, previousHash);
        if (expected !== row.entry_hash) {
          process.stderr.write(
            `BROKEN at hashed-row ${checked} id=${row.id} seq=${row.seq} timestamp=${toHashTimestamp(row.timestamp)}\n` +
              `  expected: ${expected}\n` +
              `  stored:   ${row.entry_hash}\n` +
              `  previous: ${previousHash}\n`,
          );
          process.exit(1);
        }

        previousHash = row.entry_hash;
      }

      if (result.rows.length < PAGE_SIZE) break;
    }

    if (checked === 0 && skippedNull === 0) {
      process.stdout.write('OK — audit_log is empty (genesis intact)\n');
    } else if (checked === 0) {
      process.stdout.write(
        `OK — no hashed rows yet (${skippedNull} unhashed row(s) skipped)\n`,
      );
    } else {
      process.stdout.write(
        `OK — verified ${checked} hashed row(s)` +
          (skippedNull > 0 ? `; skipped ${skippedNull} unhashed row(s)` : '') +
          '; chain intact\n',
      );
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `audit-verify failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  } finally {
    await pool.end();
  }
}

void main();
