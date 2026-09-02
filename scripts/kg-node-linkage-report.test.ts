// scripts/kg-node-linkage-report.test.ts
//
// Unit tests for the KG node linkage report (#1694 / ADR-040).
//
// The report's job is to size migration 085 before it is written: how many contacts
// hold no KG node, and how do they split across the two backfill arms (organization
// contacts that can be re-linked to an existing org node, vs contacts that need a
// node minted). A wrong number here mis-sizes the migration, and a *silently* wrong
// number is worse than a loud failure — so several of these tests assert that the
// report refuses to produce a plausible-looking answer rather than guessing.

import { describe, it, expect, vi } from 'vitest';
import { runLinkageReport } from './kg-node-linkage-report.js';

type MockPool = { query: ReturnType<typeof vi.fn> };

function makePool(rows: unknown[]): MockPool {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe('runLinkageReport', () => {
  it('splits the nodeless population across the two backfill arms', async () => {
    const pool = makePool([
      { kind: 'person', total: '120', nodeless: '9', org_arm: '0', shadowed: '7' },
      { kind: 'organization', total: '30', nodeless: '6', org_arm: '4', shadowed: '0' },
      { kind: 'automated', total: '15', nodeless: '0', org_arm: '0', shadowed: '0' },
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
    const pool = makePool([
      { kind: 'person', total: '40', nodeless: '0', org_arm: '0', shadowed: '0' },
    ]);

    const report = await runLinkageReport(pool as never);

    expect(report.totalNodeless).toBe(0);
    expect(report.orgArmEligible).toBe(0);
    expect(report.personArmMints).toBe(0);
  });

  it('handles an empty contacts table', async () => {
    const report = await runLinkageReport(makePool([]) as never);

    expect(report.totalContacts).toBe(0);
    expect(report.totalNodeless).toBe(0);
    expect(report.byKind).toEqual([]);
  });

  it('throws when the grouping column is not a usable kind', async () => {
    // String(undefined) would print "undefined" in the by-kind table, which reads
    // like a real contact kind rather than a broken query.
    const pool = makePool([{ total: '10', nodeless: '3', org_arm: '0', shadowed: '0' }]);

    await expect(runLinkageReport(pool as never)).rejects.toThrow(/"kind"/);
  });

  it('throws rather than reporting zero when an aggregate column is missing', async () => {
    // A count(*) column cannot legitimately be absent. Coercing it to 0 would print
    // "arm B (mint a node) 0" — indistinguishable from a clean database, and enough
    // to size migration 085 at zero inserts while the whole nodeless population stays
    // permanently context-free. Failing loudly is the only safe answer.
    const pool = makePool([{ kind: 'person', total: '10', nodeless: undefined }]);

    await expect(runLinkageReport(pool as never)).rejects.toThrow(/nodeless.*not a number/s);
  });

  it('throws rather than reporting a fabricated count when a column is unparseable', async () => {
    const pool = makePool([
      { kind: 'person', total: '10', nodeless: '3', org_arm: 'n/a', shadowed: '0' },
    ]);

    await expect(runLinkageReport(pool as never)).rejects.toThrow(/org_arm/);
  });

  it('throws when arm A exceeds the nodeless total instead of clamping to zero', async () => {
    // Internally inconsistent input means the query is wrong. Clamping would hide
    // that behind a plausible arm-B number, which is the one output that matters.
    const pool = makePool([
      { kind: 'organization', total: '10', nodeless: '2', org_arm: '5', shadowed: '0' },
    ]);

    await expect(runLinkageReport(pool as never)).rejects.toThrow(/internally inconsistent/);
  });

  it('reads every count from a single statement so the arms cannot drift apart', async () => {
    // Separate queries would run on separate MVCC snapshots. Against a live production
    // database with contact ingestion running, the arms could then fail to sum to the
    // total they are derived from.
    const pool = makePool([
      { kind: 'person', total: '1', nodeless: '0', org_arm: '0', shadowed: '0' },
    ]);

    await runLinkageReport(pool as never);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('never issues a write', async () => {
    const pool = makePool([
      { kind: 'person', total: '1', nodeless: '0', org_arm: '0', shadowed: '0' },
    ]);

    await runLinkageReport(pool as never);

    // This script is run against production; every statement it issues must be a SELECT.
    for (const call of pool.query.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('SELECT')).toBe(true);
    }
  });
});
