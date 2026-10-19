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
import type { Verification, VerificationConfig } from './types.js';

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
   * The table-owning service. Use it for `open`, `get` and `pendingForTask`. Do NOT
   * call its `listActive` or `close` directly: use the passthroughs below, which keep
   * the tracker's value TTL in step with the table.
   */
  readonly service: VerificationService;
  readonly tracker: CodeTracker;
  /**
   * Pending plus recently closed verifications. Every row that is not `pending`
   * (including ones the service just expired lazily) starts its tracked values' TTL
   * clock, so values age out even when nobody closed the verification explicitly.
   */
  listActive(now?: Date): Promise<Verification[]>;
  /** Close a verification and start its tracked values' TTL clock. */
  close(id: string, status: 'satisfied' | 'abandoned'): Promise<Verification | null>;
  /**
   * Where to ask the principal for a code: the first channel in the configured order
   * that is enabled AND has a verified, active principal identity. Deliberately takes
   * no argument: the channel an errand arrived on never steers the ask (a code sent
   * to a third party's inbox must not be requested there). Null when none qualifies.
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

  return {
    service,
    tracker,
    async listActive(now) {
      const rows = await service.listActive(now);
      for (const row of rows) {
        if (row.status !== 'pending') tracker.closed(row.id);
      }
      return rows;
    },
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
