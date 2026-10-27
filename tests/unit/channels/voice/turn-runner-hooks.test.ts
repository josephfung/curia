// Voice never drains a follow-up (#2018, R-14). It opens the shared loop
// without beforeFinish, and it never sees a turn lane.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('voice turn runner hooks', () => {
  it('does not install beforeFinish or a turn lane', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../../src/channels/voice/turn-runner.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('beforeFinish');
    expect(source).not.toContain('turnLanes');
    expect(source).not.toContain('frameInjectedInput');
  });
});
