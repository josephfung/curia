// send-evidence.ts — what the drafting turn actually looked up (#2159, spec "The judge's brief").
//
// Read back from audit_log: the agent.task row (what the turn was answering, and its bound
// task's progress) and the tool.result rows under it. The judge checks claims about the
// principal against this; it is passed beside the message and never written into it.
//
// Timing: the bus's audit write-ahead hook runs before publish() resolves (bus.ts onEvent),
// so every tool result a turn produced before it called a send skill is already in
// audit_log when the gateway asks.

import type { AuditLogRepo, AuditLogRow } from '../audit/audit-log-repo.js';
import type { Logger } from '../logger.js';
import type { BriefEvidence } from './judge-brief.js';

export const EVIDENCE_RESULT_MAX_CHARS = 2_000;
export const EVIDENCE_TOTAL_MAX_CHARS = 12_000;
// A turn rarely makes more than a few dozen calls; past that, the newest ones matter most.
const CHILDREN_LIMIT = 200;

export interface CollectedEvidence extends BriefEvidence {
  /** True when the audit lookup failed: grounding cannot be judged, so the caller treats it as a judge failure. */
  unavailable: boolean;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function renderResult(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload['result']) ?? '';
  } catch (err) {
    // A circular structure cannot reach audit_log as JSONB, so this is defensive only.
    return `[unrenderable result: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class SendEvidenceCollector {
  constructor(private readonly deps: {
    auditLogRepo: Pick<AuditLogRepo, 'findById' | 'findChildren'>;
    /** The injected "## Who you serve" block, read per call so identity hot-reloads (#1514) apply. */
    principalBlock: () => string | null;
    logger: Logger;
  }) {}

  /** Evidence from one or more drafting turns, newest tool result first. */
  async collect(taskEventIds: readonly string[]): Promise<CollectedEvidence> {
    const principalBlock = this.deps.principalBlock();
    if (taskEventIds.length === 0) {
      return { unavailable: true, toolResults: [], principalBlock };
    }
    try {
      // The latest turn's task row describes what the message answers.
      const latest = taskEventIds[taskEventIds.length - 1]!;
      const task = await this.deps.auditLogRepo.findById(latest);
      const content = task?.payload['content'];
      const metadata = task?.payload['metadata'];
      const boundTask = isRecord(metadata) ? metadata['boundTask'] : undefined;
      const progress = isRecord(boundTask) ? boundTask['progress'] : undefined;

      const rows: AuditLogRow[] = [];
      for (const id of taskEventIds) {
        rows.push(...await this.deps.auditLogRepo.findChildren(id, { limit: CHILDREN_LIMIT }));
      }
      const results = rows
        .filter((r) => r.eventType === 'tool.result' || r.eventType === 'skill.result')
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      const toolResults: Array<{ toolName: string; result: string }> = [];
      let total = 0;
      for (const r of results) {
        const toolName = String(r.payload['toolName'] ?? r.payload['skillName'] ?? 'unknown');
        const text = clip(renderResult(r.payload), EVIDENCE_RESULT_MAX_CHARS);
        // Newest first, so the budget keeps the lookups closest to the send.
        if (total + text.length > EVIDENCE_TOTAL_MAX_CHARS) break;
        total += text.length;
        toolResults.push({ toolName, result: text });
      }

      return {
        unavailable: false,
        ...(typeof content === 'string' ? { taskContent: clip(content, EVIDENCE_RESULT_MAX_CHARS) } : {}),
        ...(progress !== undefined ? { taskProgress: clip(JSON.stringify(progress), EVIDENCE_RESULT_MAX_CHARS) } : {}),
        toolResults,
        principalBlock,
      };
    } catch (err) {
      this.deps.logger.error({ err, taskEventIds }, 'send-evidence: audit lookup failed — grounding cannot be judged');
      return { unavailable: true, toolResults: [], principalBlock };
    }
  }
}
