// src/channels/channel-conformance.test.ts
// Compile-time + light runtime check that each adapter satisfies the Channel interface.
// We assert the static shape (name, isToggleable, start, stop) without constructing the
// adapters (which need live deps) by using `satisfies`-style type assertions in a typed
// helper plus a runtime prototype check.
import { describe, it, expect } from 'vitest';
import type { Channel } from './channel.js';
import { CliAdapter } from './cli/cli-adapter.js';
import { SignalAdapter } from './signal/signal-adapter.js';
import { EmailAdapter } from './email/email-adapter.js';
import { HttpAdapter } from './http/http-adapter.js';

// Type-level assertion: each class's instance type must be assignable to Channel.
// If an adapter is missing a member, this file fails to typecheck.
// The aliases are `export`ed so the repo's `noUnusedLocals` rule doesn't flag them
// as unused — the assertion lives purely in the `T extends Channel` constraint.
type AssertChannel<T extends Channel> = T;
export type _Cli = AssertChannel<CliAdapter>;
export type _Signal = AssertChannel<SignalAdapter>;
export type _Email = AssertChannel<EmailAdapter>;
export type _Http = AssertChannel<HttpAdapter>;

describe('channel adapters implement Channel', () => {
  it('expose start and stop on their prototypes', () => {
    for (const cls of [CliAdapter, SignalAdapter, EmailAdapter, HttpAdapter]) {
      expect(typeof cls.prototype.start).toBe('function');
      expect(typeof cls.prototype.stop).toBe('function');
    }
  });
});
