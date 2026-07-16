import { describe, it, expect } from 'vitest';
import { buildVoiceGuidePrompt, parsePendingDiffs } from './voice-learn-logic.js';

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

describe('buildVoiceGuidePrompt', () => {
  it('includes the current guide and the draft/sent pairs and asks for an updated guide', () => {
    const pairs = parsePendingDiffs(SAMPLE_DIFFS);
    const prompt = buildVoiceGuidePrompt('Existing guide: writes short.', pairs);
    expect(prompt).toContain('Existing guide: writes short.');
    expect(prompt).toContain('Best regards'); // from a draft body
    expect(prompt).toMatch(/how the (ceo|executive) writes/i);
  });

  it('handles an empty current guide', () => {
    expect(buildVoiceGuidePrompt('', parsePendingDiffs(SAMPLE_DIFFS))).toMatch(/how the (ceo|executive) writes/i);
  });
});
