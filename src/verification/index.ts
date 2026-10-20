// Runtime bundle for delegated sign-in verification (#2017): the service that owns
// the verifications table, the in-memory code tracker, and the channel to ask the
// principal on. Built once at startup and handed to the execution layer, which
// scrubs tracked codes out of tool inputs and injects the bundle into tools that
// declare the `verification` capability.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { ChannelIdentity } from '../contacts/types.js';
import { CodeTracker } from './code-tracker.js';
import { VerificationService } from './verification-service.js';
import type { OpenVerificationInput, Verification, VerificationConfig } from './types.js';

/**
 * Identity channels that can reach the principal on a given ask channel. An `sms` ask
 * is satisfied by a verified `sms` or `phone` identity; every other channel matches
 * its own name.
 */
const IDENTITY_CHANNELS_FOR: Readonly<Record<string, readonly string[]>> = {
  sms: ['sms', 'phone'],
};

export interface VerificationRuntime {
  /**
   * The table-owning service. Use it for `get` and `pendingForTask`. Do NOT call its
   * `open`, `listActive` or `close` directly: use the passthroughs below, which keep
   * the tracker's value TTL in step with the table.
   */
  readonly service: VerificationService;
  readonly tracker: CodeTracker;
  /**
   * Open a verification (or reuse the pending one for the site, refreshed to this
   * session and page domain; tracked values are retargeted to the new page domain). The
   * service expires a site's stale pending row silently on the way in; this then starts
   * the TTL clock for any tracked values whose verification is no longer pending.
   */
  open(input: OpenVerificationInput): Promise<{ verification: Verification; reused: boolean }>;
  /**
   * Pending plus recently closed verifications. Every tracked verification that is not
   * a returned `pending` row (closed, lazily expired, or aged out of the recent window
   * and so not returned at all) starts its tracked values' TTL clock, so values age
   * out even when nobody closed the verification explicitly.
   */
  listActive(now?: Date): Promise<Verification[]>;
  /** Close a verification and start its tracked values' TTL clock. */
  close(id: string, status: 'satisfied' | 'abandoned'): Promise<Verification | null>;
  /**
   * Where to ask the principal for a code: the first channel in the configured order
   * that is enabled AND has a verified, active principal identity. Deliberately takes
   * no argument: the configured order alone decides, and the channel the errand
   * arrived on plays no part (the principal often hands things over by email or voice
   * to be done later, so it says nothing about where they are now). Null when none
   * qualifies.
   */
  askChannel(): string | null;
}

/**
 * @param principalIdentities The live array from bootstrap, mutated in place on
 *   refresh. It is read on every askChannel() call, never copied.
 * @param enabledChannels Channels that are actually running this boot.
 */
export function createVerificationRuntime(
  pool: DbPool,
  logger: Logger,
  config: VerificationConfig,
  principalIdentities: readonly ChannelIdentity[],
  enabledChannels: ReadonlySet<string>,
): VerificationRuntime {
  const service = new VerificationService(pool, logger, config);
  const tracker = new CodeTracker({ ttlMinutesAfterClose: config.codeTtlMinutesAfterClose });

  /** Start the TTL clock for every tracked verification that is not among `pendingIds`. */
  function closeUnlessPending(pendingIds: ReadonlySet<string>): void {
    for (const id of tracker.trackedIds()) {
      if (!pendingIds.has(id)) tracker.closed(id);
    }
  }

  async function reconcile(now?: Date): Promise<Verification[]> {
    const rows = await service.listActive(now);
    closeUnlessPending(new Set(rows.filter((r) => r.status === 'pending').map((r) => r.id)));
    return rows;
  }

  return {
    service,
    tracker,
    async open(input) {
      const result = await service.open(input);
      // A reused row was refreshed to the caller's page domain; values already tracked
      // for it must follow, or the browser guard would refuse the code on the new page.
      if (result.reused) tracker.retarget(result.verification.id, result.verification.pageDomain);
      // The pending set after open is the (possibly new) row alone for this site, but
      // other sites may have pending rows too, so ask the table rather than guess.
      await reconcile();
      return result;
    },
    listActive: reconcile,
    async close(id, status) {
      const row = await service.close(id, status);
      tracker.closed(id);
      return row;
    },
    askChannel() {
      for (const channel of config.askChannelOrder) {
        if (!enabledChannels.has(channel)) continue;
        const identityChannels = IDENTITY_CHANNELS_FOR[channel] ?? [channel];
        const reachable = principalIdentities.some(
          (identity) =>
            identityChannels.includes(identity.channel) &&
            identity.verified &&
            identity.status === 'active',
        );
        if (reachable) return channel;
      }
      return null;
    },
  };
}
