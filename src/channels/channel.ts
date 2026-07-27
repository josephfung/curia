// src/channels/channel.ts
// Formal contract every channel adapter implements. Replaces the previous duck-typed
// pattern (adapters historically exposed only start()). `isToggleable` is false for the
// always-on safeguard channels (http, cli) which must never be disabled from the UI.

export interface Channel {
  /** Stable identifier: 'email' | 'signal' | 'slack' | 'sms' | 'voice' | 'http' | 'cli'. Matches the catalog + registry row. */
  readonly name: string;
  /** False for http and cli — they always start and cannot be disabled/uninstalled. */
  readonly isToggleable: boolean;
  start(): Promise<void>;
  /** Graceful teardown (used on process shutdown). Idempotent. */
  stop(): Promise<void>;

  /**
   * When true, OutboundGateway may durably queue post-policy sends while the
   * transport is unavailable and flush them on `channel.reconnect` (#1380).
   *
   * Opt in for messaging transports that can recover (Signal socket, Slack Socket
 * Mode, SMS/email HTTP with transient outages). Leave unset for realtime (voice) and
 * always-local (http, cli) channels — delayed delivery is not meaningful there.
   *
   * Adapters that set this must:
   *   1. Implement `isOutboundReady()`
   *   2. Publish `channel.disconnected` / `channel.reconnect` on the bus when
   *      readiness flips (so the gateway flushes without polling)
   *   3. Be registered in the gateway's `outboundQueueReadiness` map at bootstrap
   */
  readonly supportsOutboundQueue?: boolean;

  /**
   * Whether outbound wire dispatch should proceed now. Required when
   * `supportsOutboundQueue` is true. Gateway enqueues instead of calling the
   * platform when this returns false.
   */
  isOutboundReady?(): boolean;
}
