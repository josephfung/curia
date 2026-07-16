import { describe, it, expect } from 'vitest';
import {
  parsePendingDiffs,
  proposeDeltasFromPairs,
  decideApplication,
  isNearDefaultProfile,
  DEFAULT_PROVENANCE,
  type ParsedDiffPair,
} from './voice-learn-logic.js';

const SAMPLE_DIFFS = `
# Pending voice diffs

## Diff — draft d1 ↔ sent m1

- thread_id: t1
- confidence: high
- sent_at: 2026-07-01T12:00:00.000Z
- subject: Hello
- recipients: alice@example.com

### Draft

Hi Alice, Best regards

### Sent

Hi Alice, Thanks

---

## Diff — draft d2 ↔ sent m2

- thread_id: t2
- confidence: high
- sent_at: 2026-07-02T12:00:00.000Z
- subject: Hello
- recipients: bob@example.com

### Draft

Hello Bob, Best regards

### Sent

Hello Bob, Thanks

---

## Diff — draft d3 ↔ sent m3

- thread_id: t3
- confidence: high
- sent_at: 2026-07-03T12:00:00.000Z
- subject: Hello
- recipients: carol@example.com

### Draft

Hi Carol, Best regards

### Sent

Hi Carol, Thanks

---

## Diff — draft d4 ↔ sent m4

- thread_id: t4
- confidence: high
- sent_at: 2026-07-04T12:00:00.000Z
- subject: Hello
- recipients: dave@example.com

### Draft

Hi Dave, this went out unchanged.

### Sent

Hi Dave, this went out unchanged.

---
`;

describe('parsePendingDiffs', () => {
  it('parses qualifying pairs and skips verbatim', () => {
    const pairs = parsePendingDiffs(SAMPLE_DIFFS);
    // d4 is a verbatim send (draft === sent) and must be filtered out, leaving 3.
    expect(pairs).toHaveLength(3);
    expect(pairs.map((p) => p.draftId)).not.toContain('d4');
    expect(pairs[0]!.draftId).toBe('d1');
    expect(pairs[0]!.sentBody).toContain('Thanks');
  });

  it('does not truncate a sent body at an internal --- rule', () => {
    const withRule = `
## Diff — draft d9 ↔ sent m9

- sent_at: 2026-07-05T12:00:00.000Z
- subject: Update

### Draft

Hi team, quick update below. Best regards.

### Sent

Hi team, quick update below.

---

Sent from my phone. Thanks!

---
`;
    const pairs = parsePendingDiffs(withRule);
    expect(pairs).toHaveLength(1);
    // The trailing signature after the internal --- must survive (last delimiter wins).
    expect(pairs[0]!.sentBody).toContain('Sent from my phone');
  });

  it('excludes an equal-length but unrelated rewrite (not shared-prefix based)', () => {
    // Draft and sent are the same length yet share almost no vocabulary — must be
    // treated as a near-total rewrite and dropped, not fed to learning.
    const unrelated = `
## Diff — draft d10 ↔ sent m10

- sent_at: 2026-07-06T12:00:00.000Z
- subject: Note

### Draft

Please review the budget spreadsheet before Friday afternoon.

### Sent

Congratulations again; dinner reservation confirmed for eight guests.

---
`;
    expect(parsePendingDiffs(unrelated)).toHaveLength(0);
  });
});

describe('proposeDeltasFromPairs + decideApplication', () => {
  it('auto-applies vocabulary when thresholds met', () => {
    const pairs = parsePendingDiffs(SAMPLE_DIFFS);
    const deltas = proposeDeltasFromPairs(pairs);
    const vocab = deltas.find((d) => d.field === 'vocabulary');
    expect(vocab).toBeDefined();
    // Force sample counts to meet threshold for the unit test of decide path.
    const decision = decideApplication(
      { ...vocab!, sampleCount: 3, consistency: 0.8, magnitude: 'low' },
      DEFAULT_PROVENANCE,
      {
        currentSignOffEmpty: true,
        currentVocabularyEmpty: true,
        dismissedDimensions: new Set(),
      },
    );
    expect(decision.action).toBe('auto');
  });

  it('proposes operator-set fields never auto', () => {
    const delta = {
      field: 'signOff' as const,
      description: 'Prefer Thanks',
      patch: { sign_off: 'Thanks' },
      sampleCount: 5,
      consistency: 1,
      magnitude: 'low' as const,
    };
    const decision = decideApplication(
      delta,
      { ...DEFAULT_PROVENANCE, signOff: 'operator-set' },
      {
        currentSignOffEmpty: false,
        currentVocabularyEmpty: false,
        dismissedDimensions: new Set(),
      },
    );
    expect(decision.action).toBe('propose');
    expect(decision.reason).toBe('operator-set-field');
  });

  it('cold-start detects near-default profile', () => {
    expect(
      isNearDefaultProfile({
        tone: ['direct', 'warm'],
        formality: 50,
        patterns: ['Concise and to the point', 'Professional but approachable'],
        vocabulary: { prefer: [], avoid: [] },
        signOff: '',
      }),
    ).toBe(true);
  });

  it('auto-fills empty seeded sign-off when samples suffice', () => {
    const pairs: ParsedDiffPair[] = parsePendingDiffs(SAMPLE_DIFFS);
    const deltas = proposeDeltasFromPairs(pairs);
    const sign = deltas.find((d) => d.field === 'signOff');
    expect(sign).toBeDefined();
    const decision = decideApplication(sign!, DEFAULT_PROVENANCE, {
      currentSignOffEmpty: true,
      currentVocabularyEmpty: true,
      dismissedDimensions: new Set(),
    });
    expect(decision.action).toBe('auto');
    expect(decision.reason).toContain('signoff');
  });
});
