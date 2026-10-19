// handler.ts — record-spot-check (#2159 Phase 3).
//
// Records the principal's numbered verdicts ("2 bad, that was a renewal notice") on a digest's
// spot-check block. The numbers resolve against the digest the reply refers to (see
// src/reports/spot-check-verdicts.ts); each verdict then lands on that action's audit row as a
// principal-scored competence flag, which feeds the autonomy score.
//
// The tool is action_risk "none" so the principal can answer at any band. Its guard is the
// live-principal-turn check instead: only the principal's own, live reply can grade an action.
// Without it, a third party's email reading "2 good" could score Curia's work for it, and a
// woken or scheduled principal-lineage task could grade its own actions.
//
// Second guard (#2159 F2): on the principal's own live turn, injected text in quoted or
// forwarded mail, or in a tool result, could still steer the coordinator into calling this
// tool with numbers the principal never typed. The dispatcher stamps the pairs the principal
// typed into trusted task metadata (`spotCheckVerdicts`, stripped from untrusted metadata in
// mergeTaskMetadata), and every requested pair must be one of them.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { isLivePrincipalTurn } from '../../../../src/contacts/principal.js';
import { SpotCheckStore } from '../../../../src/reports/spot-check-store.js';
import {
  resolveSpotCheckSet,
  matchVerdicts,
  type SpotCheckVerdictInput,
} from '../../../../src/reports/spot-check-verdicts.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';

const MAX_REASON_LENGTH = 500;

const NOT_TYPED_ERROR =
  'record-spot-check only records the numbers and verdicts the principal typed in this message. Nothing was recorded.';

/**
 * Whether every requested { n, verdict } is among the pairs the dispatcher stamped from the
 * principal's own text. Anything other than an array of { n, verdict } pairs (absent, a
 * forged string, a malformed entry) is treated as no pairs, so it fails closed. Reasons are
 * not checked: they come from the principal's text but the coordinator may paraphrase them.
 */
function allTyped(stamp: unknown, verdicts: readonly SpotCheckVerdictInput[]): boolean {
  if (!Array.isArray(stamp)) return false;
  const typed = stamp.filter(
    (p): p is { n: number; verdict: 'good' | 'bad' } =>
      isPlainObject(p) && typeof p['n'] === 'number' && (p['verdict'] === 'good' || p['verdict'] === 'bad'),
  );
  return verdicts.every((v) => typed.some((t) => t.n === v.n && t.verdict === v.verdict));
}

type ParseResult = { ok: true; verdicts: SpotCheckVerdictInput[] } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate `verdicts`: a non-empty array of { n: positive integer, verdict: good|bad, reason?: string }. */
function parseVerdicts(raw: unknown): ParseResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'verdicts must be a non-empty array of { n, verdict, reason? }' };
  }
  const verdicts: SpotCheckVerdictInput[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isPlainObject(entry)) {
      return { ok: false, error: `verdicts[${i}] must be an object { n, verdict, reason? }` };
    }
    const { n, verdict, reason } = entry;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      return { ok: false, error: `verdicts[${i}].n must be a positive whole number (the spot-check line's number)` };
    }
    if (verdict !== 'good' && verdict !== 'bad') {
      return { ok: false, error: `verdicts[${i}].verdict must be 'good' or 'bad'` };
    }
    // null is treated as absent: models often send null for an optional field they have no value for.
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      return { ok: false, error: `verdicts[${i}].reason must be a string when given` };
    }
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (trimmed.length > MAX_REASON_LENGTH) {
      return { ok: false, error: `verdicts[${i}].reason must be at most ${MAX_REASON_LENGTH} characters` };
    }
    // An empty or whitespace-only reason carries nothing, so it is stored as no reason.
    verdicts.push(trimmed ? { n, verdict, reason: trimmed } : { n, verdict });
  }
  return { ok: true, verdicts };
}

export class RecordSpotCheckHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.actionLogRepo) {
      return { success: false, error: 'record-spot-check requires actionLogRepo capability' };
    }
    if (!ctx.entityMemory) {
      return { success: false, error: 'record-spot-check requires entityMemory capability' };
    }
    const actionLogRepo = ctx.actionLogRepo;
    const entityMemory = ctx.entityMemory;

    try {
      const parsed = parseVerdicts(ctx.input['verdicts']);
      if (!parsed.ok) return { success: false, error: parsed.error };

      // Review Focus 1: checked before any read or write, so a refused call touches nothing.
      //
      // The wakeContext check mirrors the elevated-skill gate in src/skills/execution.ts (the
      // `isWokenTurn` check there); keep the two in step. This tool is `normal` sensitivity, so
      // that gate never runs for it and this is its only principal guard. A woken
      // principal-lineage task can keep its principal originator through the bypass ladder
      // (computeEffectiveTaskMetadata), so if `liveTurn` ever leaked onto a wake, the live-turn
      // check alone would let a heartbeat-woken task grade its own sampled actions.
      const isWokenTurn = ctx.taskMetadata?.['wakeContext'] !== undefined;
      if (isWokenTurn || !isLivePrincipalTurn(ctx.liveTurn, ctx.taskMetadata)) {
        ctx.log.warn(
          { channelId: ctx.channelId, conversationId: ctx.conversationId },
          'record-spot-check: refused outside a live principal turn',
        );
        return { success: false, error: 'record-spot-check only records the principal\'s own reply' };
      }

      // F2: also before any read or write. The log carries numbers and verdicts only.
      const typedStamp = ctx.taskMetadata?.['spotCheckVerdicts'];
      if (!allTyped(typedStamp, parsed.verdicts)) {
        ctx.log.warn(
          {
            channelId: ctx.channelId,
            conversationId: ctx.conversationId,
            requested: parsed.verdicts.map((v) => ({ n: v.n, verdict: v.verdict })),
            typed: Array.isArray(typedStamp) ? typedStamp : null,
          },
          'record-spot-check: refused verdicts the principal did not type in this message',
        );
        return { success: false, error: NOT_TYPED_ERROR };
      }

      const store = new SpotCheckStore(new ConfigStore(entityMemory, ctx.log), ctx.log);
      const resolved = await resolveSpotCheckSet(store, {
        ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
        ...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
      });
      if (!resolved.ok) return { success: false, error: resolved.error };

      // All numbers are checked before the first write, so an unknown number writes nothing.
      const matched = matchVerdicts(resolved.set, parsed.verdicts);
      if (!matched.ok) return { success: false, error: matched.error };

      const recorded: Array<{ n: number; summary: string; verdict: 'good' | 'bad' }> = [];
      for (const m of matched.matched) {
        const written = await actionLogRepo.recordPrincipalVerdict(m.item.actionLogId, m.verdict === 'good', m.reason ?? null);
        if (!written) {
          // The row was deleted or is no longer a pool row. The other verdicts still stand; this
          // number is left out of `recorded` so the coordinator does not claim it was noted.
          ctx.log.warn(
            { setId: resolved.set.id, n: m.n, actionLogId: m.item.actionLogId },
            'record-spot-check: action log row is not a sample-pool row; verdict not recorded',
          );
          continue;
        }
        recorded.push({ n: m.n, summary: m.item.summary, verdict: m.verdict });
      }

      ctx.log.info(
        { setId: resolved.set.id, requested: matched.matched.length, recorded: recorded.length },
        'record-spot-check: recorded principal verdicts',
      );
      return { success: true, data: { recorded } };
    } catch (err) {
      ctx.log.error({ err }, 'record-spot-check: failed to record verdicts');
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `record-spot-check failed: ${message}` };
    }
  }
}
