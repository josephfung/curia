// activity-service.ts — reads and projects the console activity feed (#2251).
//
// Read path for GET /api/activity: newest jobs from audit_log, names and job
// labels resolved in one batch, then the pure projection. It makes no model
// calls: conversational summaries were written once, at job completion, by
// ActivitySummarizer, and are read back here as activity.summary rows.

import type { AuditLogRepo } from '../audit/audit-log-repo.js';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import type { ActionLogRow } from '../autonomy/action-log-types.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { Logger } from '../logger.js';
import { isUuid } from '../util/uuid.js';
import { collectActivityRefs, projectActivity, type ActivityRows } from './projection.js';
import { scrubContactDetails } from './scrub.js';
import type { ActivityItem, ActivityPage } from './types.js';

export interface ActivityServiceDeps {
  auditLogRepo: Pick<AuditLogRepo, 'findActivityJobs' | 'findActivityJobsByIds'>;
  actionLogRepo?: Pick<ActionLogRepo, 'findTerminalBetween'>;
  contactService: Pick<ContactService, 'getContact' | 'findContactBySystemRole' | 'resolveByChannelIdentity'>;
  schedulerService?: Pick<SchedulerService, 'getJob'>;
  /** Office timezone (config.timezone), used when the principal has none. */
  officeTimezone: string;
  logger: Logger;
}

/** Shape the console reads; also the service's public read contract. */
export interface ActivityFeedSource {
  list(query: { from: Date; to: Date; limit: number }): Promise<ActivityPage>;
}

/**
 * Roots read per page, per requested item. Some jobs project to nothing
 * (no reply and no tool work), so each page reads more than asked for, and
 * list() keeps paging until it has enough items.
 */
const ROOTS_PER_ITEM = 4;
const MIN_ROOTS_PER_PAGE = 50;
const MAX_ROOTS_PER_PAGE = 200;
/** Pages read per request before reporting hasMore instead (1,000 roots). */
const MAX_PAGES = 5;
/** An approval can land after its job: autonomy rows are read this far past the window. */
const AUTONOMY_TAIL_MS = 24 * 60 * 60 * 1000;
/** Autonomy rows read per request; reaching it is logged, since older items then lose their label. */
const AUTONOMY_ROW_LIMIT = 5000;
/** Cap on distinct names resolved per request — each is a DB round-trip. */
const MAX_NAME_LOOKUPS = 100;
const JOB_LABEL_MAX = 60;

/**
 * A short label for a scheduled job: its task title, else the first sentence of
 * its task text. That text is job configuration, so it is scrubbed of emails,
 * links and phone numbers like the model summaries are.
 */
export function jobLabelFrom(job: { taskTitle: string | null; taskPayload: Record<string, unknown> }): string | null {
  const title = job.taskTitle?.trim();
  const raw = title && title.length > 0
    ? title
    : typeof job.taskPayload.task === 'string' ? job.taskPayload.task : '';
  const firstSentence = raw.split(/(?<=[.!?])\s|\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  const sentence = scrubContactDetails(firstSentence).replace(/[.!?]+$/, '').trim();
  if (sentence.length === 0) return null;
  return sentence.length > JOB_LABEL_MAX ? `${sentence.slice(0, JOB_LABEL_MAX - 1)}…` : sentence;
}

export class ActivityService implements ActivityFeedSource {
  constructor(private readonly deps: ActivityServiceDeps) {}

  async list(query: { from: Date; to: Date; limit: number }): Promise<ActivityPage> {
    const { rows, hasMore: rootsRemain } = await this.readRoots(query);
    const { items, timezone } = await this.project(rows, query.from, query.to);
    return {
      items: items.slice(0, query.limit),
      hasMore: items.length > query.limit || rootsRemain,
      timezone,
    };
  }

  /**
   * The items for named root jobs, newest first (the console's hiccup list,
   * #2350). A job with nothing to show is dropped, as in {@link list}.
   */
  async listByIds(ids: string[], to: Date = new Date()): Promise<ActivityItem[]> {
    const rows = await this.deps.auditLogRepo.findActivityJobsByIds(ids, to);
    const oldest = rows.roots[rows.roots.length - 1];
    if (!oldest) return [];
    const { items } = await this.project(rows, oldest.timestamp, to);
    return items;
  }

  /** Resolve names, job labels and autonomy rows, then project. */
  private async project(rows: ActivityRows, from: Date, to: Date): Promise<{ items: ActivityItem[]; timezone: string }> {
    const { deps } = this;
    const principal = await this.lookup('principal contact', () => deps.contactService.findContactBySystemRole('principal'));
    const timezone = principal?.timezone ?? deps.officeTimezone;

    const refs = collectActivityRefs(rows);
    const [names, jobLabels, autonomyRows] = await Promise.all([
      this.resolveNames(refs.names, principal?.displayName ?? null),
      this.resolveJobLabels(refs.jobIds),
      this.loadAutonomyRows(from, to),
    ]);

    const items = projectActivity(rows, {
      timezone,
      name: (ref) => names.get(ref) ?? null,
      jobLabel: (jobId) => jobLabels.get(jobId) ?? null,
      autonomyRows,
    });
    return { items, timezone };
  }

  /**
   * Read roots newest first, a page at a time, until more than `limit` of them
   * project to an item or the window runs out. Whether a job shows depends only
   * on its rows, not on names or labels, so each page is counted with a bare
   * projection before anything is resolved. `hasMore` is true when roots remain
   * unread: the window was not exhausted.
   */
  private async readRoots(query: { from: Date; to: Date; limit: number }): Promise<{ rows: ActivityRows; hasMore: boolean }> {
    const pageSize = Math.min(Math.max(query.limit * ROOTS_PER_ITEM, MIN_ROOTS_PER_PAGE), MAX_ROOTS_PER_PAGE);
    const rows: ActivityRows = { roots: [], delegated: [], children: [] };
    const countCtx = { timezone: 'UTC', name: () => null, jobLabel: () => null, autonomyRows: [] };
    let visible = 0;
    let before: { timestamp: Date; id: string } | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.deps.auditLogRepo.findActivityJobs({ from: query.from, to: query.to, limit: pageSize, before });
      rows.roots.push(...result.roots);
      rows.delegated.push(...result.delegated);
      rows.children.push(...result.children);
      visible += projectActivity(result, countCtx).length;
      if (!result.hasMore || !result.nextCursor) return { rows, hasMore: false };
      if (visible > query.limit) return { rows, hasMore: true };
      before = result.nextCursor;
    }
    this.deps.logger.warn(
      { pages: MAX_PAGES, pageSize, visible, limit: query.limit },
      'activity: page bound reached before the feed filled; older jobs not read',
    );
    return { rows, hasMore: true };
  }

  /** Run one lookup; a failure degrades that name to its fallback, logged. */
  private async lookup<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.deps.logger.warn({ err, what }, 'activity: lookup failed, falling back');
      return null;
    }
  }

  private async resolveNames(refs: Set<string>, principalName: string | null): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (principalName) names.set('principal', principalName);
    const pending = [...refs].filter((r) => r !== 'principal').slice(0, MAX_NAME_LOOKUPS);
    if (refs.size > MAX_NAME_LOOKUPS) {
      this.deps.logger.warn({ refs: refs.size, cap: MAX_NAME_LOOKUPS }, 'activity: too many names to resolve; the rest fall back');
    }
    await Promise.all(pending.map(async (ref) => {
      if (ref.startsWith('email:')) {
        const sender = await this.lookup('contact by email', () =>
          this.deps.contactService.resolveByChannelIdentity('email', ref.slice('email:'.length)));
        if (sender?.displayName) names.set(ref, sender.displayName);
        return;
      }
      // Anything else a describer returns is a contact id; skip non-ids rather
      // than hand the contacts table a malformed key.
      if (!isUuid(ref)) return;
      const contact = await this.lookup('contact by id', () => this.deps.contactService.getContact(ref));
      if (contact?.displayName) names.set(ref, contact.displayName);
    }));
    return names;
  }

  private async resolveJobLabels(jobIds: Set<string>): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const scheduler = this.deps.schedulerService;
    if (!scheduler) return labels;
    await Promise.all([...jobIds].map(async (jobId) => {
      const job = await this.lookup('scheduled job', () => scheduler.getJob(jobId));
      const label = job ? jobLabelFrom(job) : null;
      if (label) labels.set(jobId, label);
    }));
    return labels;
  }

  private async loadAutonomyRows(from: Date, to: Date): Promise<ActionLogRow[]> {
    const repo = this.deps.actionLogRepo;
    if (!repo) return [];
    // Past the window end, so an approval that landed after its job still labels it.
    const until = new Date(Math.min(Date.now(), to.getTime() + AUTONOMY_TAIL_MS));
    const rows = await this.lookup('autonomy action log', () => repo.findTerminalBetween(from, until, AUTONOMY_ROW_LIMIT));
    if (rows && rows.length >= AUTONOMY_ROW_LIMIT) {
      this.deps.logger.warn(
        { limit: AUTONOMY_ROW_LIMIT, from, until },
        'activity: autonomy rows hit the read limit; the oldest items may lose their approved/autonomous label',
      );
    }
    return rows ?? [];
  }
}
