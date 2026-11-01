import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('session renewal wiring', () => {
  it('HttpAdapter binds the session renewer', () => {
    const source = readFileSync(new URL('../../../../src/channels/http/http-adapter.ts', import.meta.url), 'utf8');
    expect(source).toContain('bindSessionRenewer(');
  });
});
