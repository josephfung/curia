// The coordinator pins the principal's priorities document (#2362, ADR-056).
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import { parsePinnedContext, pinnedDocPaths } from '../../../src/agents/pinned-context.js';
import { PRIORITIES_PATH } from '../../../src/memory/priorities-doc.js';

const coordinator = () => loadAgentConfig(resolve(import.meta.dirname, '../../../agents/coordinator.yaml'));

describe('coordinator pinned_context', () => {
  it('pins the priorities document with a ≤300-char description', () => {
    const entries = parsePinnedContext(coordinator().pinned_context, 'coordinator');
    const entry = entries.find((e) => e.kind === 'doc' && e.path === PRIORITIES_PATH);
    expect(entry).toBeDefined();
    expect(entry!.description).toBeTruthy();
    expect(entry!.description!.length).toBeLessThanOrEqual(300);
    expect(pinnedDocPaths(entries)).toContain(PRIORITIES_PATH);
  });
});
