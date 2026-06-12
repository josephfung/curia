// src/channels/channel.ts
// Formal contract every channel adapter implements. Replaces the previous duck-typed
// pattern (adapters historically exposed only start()). `isToggleable` is false for the
// always-on safeguard channels (http, cli) which must never be disabled from the UI.

export interface Channel {
  /** Stable identifier: 'email' | 'signal' | 'http' | 'cli'. Matches the catalog + registry row. */
  readonly name: string;
  /** False for http and cli — they always start and cannot be disabled/uninstalled. */
  readonly isToggleable: boolean;
  start(): Promise<void>;
  /** Graceful teardown (used on process shutdown). Idempotent. */
  stop(): Promise<void>;
}
