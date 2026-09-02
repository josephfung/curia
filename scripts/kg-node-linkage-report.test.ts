// scripts/kg-node-linkage-report.test.ts
//
// Unit tests for the KG node linkage report (#1694 / ADR-040).
//
// The report's job is to size migration 085 before it is written: how many contacts
// hold no KG node, and how do they split across the two backfill arms (organization
// contacts that can be re-linked to their org's existing node, vs contacts that need
// a node minted). Getting the arithmetic wrong here would mis-size the migration, so
// the split is what these tests pin down.

import { describe, it, expect, vi } from 'vitest';
import { runLinkageReport } from './kg-node-linkage-report.js';

type MockPool = { query: ReturnType<typeof vi.fn> };

// Responds to queries in order. Throws on an unexpected extra call so a new query
// added to the report can't silently read an unrelated stub.
function makeSequentialPool(responses: Array<{ rows: unknown[] }>): MockPool {
  let i = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const res = responses[i++];
      if (!res) throw new Error(`Unexpected query call #${i} — add a response`);
      return Promise.resolve(res);
    }),
  };
}

describe('runLinkageReport', () => {
  it('splits the nodeless population across the two backfill arms', async () => {
    const pool = makeSequentialPool([
      // 1. totals by kind
      {
        rows: [
          { kind: 'person', total: '120', nodeless: '9' },
          { kind: 'organization', total: '30', nodeless: '6' },
          { kind: 'automated', total: '15', nodeless: '0' },
        ],
      },
      // 2. org-arm eligible
      { rows: [{ eligible: '4' }] },
      // 3. shadowed by a same-name contact that does have a node
      { rows: [{ shadowed: '7' }] },
    ]);

    const report = await runLinkageReport(pool as never);

    expect(report.totalContacts).toBe(165);
    expect(report.totalNodeless).toBe(15);
    expect(report.byKind).toEqual([
      { kind: 'person', total: 120, nodeless: 9 },
      { kind: 'organization', total: 30, nodeless: 6 },
      { kind: 'automated', total: 15, nodeless: 0 },
    ]);
    // Arm A re-links org contacts to an existing org node; arm B mints the rest.
    expect(report.orgArmEligible).toBe(4);
    expect(report.personArmMints).toBe(11);
    expect(report.sameNameShadowed).toBe(7);
  });

  it('reports a clean database as zero work, not as an error', async () => {
    const pool = makeSequentialPool([
      { rows: [{ kind: 'person', total: '40', nodeless: '0' }] },
      { rows: [{ eligible: '0' }] },
      { rows: [{ shadowed: '0' }] },
    ]);

    const report = await runLinkageReport(pool as never);

    expect(report.totalNodeless).toBe(0);
    expect(report.orgArmEligible).toBe(0);
    expect(report.personArmMints).toBe(0);
  });

  it('handles an empty contacts table without producing NaN', async () => {
    const pool = makeSequentialPool([
      { rows: [] },
      { rows: [{ eligible: '0' }] },
      { rows: [{ shadowed: '0' }] },
    ]);

    const report = await runLinkageReport(pool as never);

    expect(report.totalContacts).toBe(0);
    expect(report.totalNodeless).toBe(0);
    expect(report.byKind).toEqual([]);
  });

  it('tolerates a missing aggregate row rather than yielding NaN', async () => {
    // count(*) always returns a row in practice, but a defensive default keeps a
    // surprising empty result from turning the whole report into NaN arithmetic.
    const pool = makeSequentialPool([
      { rows: [{ kind: 'person', total: '10', nodeless: '3' }] },
      { rows: [] },
      { rows: [] },
    ]);

    const report = await runLinkageReport(pool as never);

    expect(report.orgArmEligible).toBe(0);
    expect(report.sameNameShadowed).toBe(0);
    expect(report.personArmMints).toBe(3);
  });

  it('never issues a write', async () => {
    const pool = makeSequentialPool([
      { rows: [{ kind: 'person', total: '1', nodeless: '0' }] },
      { rows: [{ eligible: '0' }] },
      { rows: [{ shadowed: '0' }] },
    ]);

    await runLinkageReport(pool as never);

    // This script is run against production; every statement it issues must be a SELECT.
    for (const call of pool.query.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('SELECT')).toBe(true);
    }
  });
});
