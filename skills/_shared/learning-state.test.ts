import { describe, it, expect } from 'vitest';
import type { ConfigStore } from '../../src/memory/config-store.js';
import {
  LEARNING_STATE_NAMESPACE,
  COMPLETION_CANDIDATES_KEY,
  COMPLETION_DIGEST_KEY,
  VOICE_PROPOSAL_KEY,
  ASKED_TASK_IDS_KEY,
  readCompletionCandidates,
  writeCompletionCandidates,
  readCompletionDigest,
  writeCompletionDigest,
  readVoiceProposal,
  writeVoiceProposal,
  readIdSet,
  writeIdSet,
  composeUndoNote,
  composeConfirmNote,
  digestMapToItems,
  type CompletionCandidateMap,
  type CompletionDigestMap,
} from './learning-state.js';

// Minimal in-memory ConfigStore double: only get/set, keyed by config key (namespace fixed).
// set() mirrors the real ConfigStore.set()'s `{ stored: boolean }` return shape — the write
// accessors in learning-state.ts now read `.stored` off it, so a double that resolved `undefined`
// would throw at runtime the moment a write accessor's boolean return is exercised.
function fakeStore(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const store = {
    get: async (_ns: string, key: string) => values.get(key) ?? null,
    set: async (_ns: string, key: string, value: string) => {
      values.set(key, value);
      return { stored: true };
    },
  } as unknown as ConfigStore;
  return { store, values };
}

// Minimal spy Logger double — just enough of the pino.Logger surface (warn) for the corruption
// callback learning-state.ts's read accessors invoke on a JSON.parse failure.
function fakeLogger() {
  const warnCalls: Array<[Record<string, unknown>, string]> = [];
  const logger = {
    warn: (obj: Record<string, unknown>, msg: string) => { warnCalls.push([obj, msg]); },
    info: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Parameters<typeof readCompletionCandidates>[1];
  return { logger, warnCalls };
}

describe('learning-state config accessors', () => {
  it('uses the ceo_inbox namespace', () => {
    expect(LEARNING_STATE_NAMESPACE).toBe('ceo_inbox');
  });

  it('reads an empty map when the key is unset or garbage', async () => {
    const { store } = fakeStore({ [COMPLETION_CANDIDATES_KEY]: 'not json' });
    expect(await readCompletionCandidates(store)).toEqual({});
    expect(await readCompletionDigest(fakeStore().store)).toEqual({});
    expect(await readVoiceProposal(fakeStore().store)).toBeNull();
    expect([...(await readIdSet(fakeStore().store, ASKED_TASK_IDS_KEY))]).toEqual([]);
  });

  it('round-trips a completion-candidate map and removes by writing the map without the entry', async () => {
    const { store, values } = fakeStore();
    const map: CompletionCandidateMap = {
      t1: { messageId: 'm1', confidence: 'high', reason: 'r', sentAt: 's', subject: 'sub', recipients: ['a@x'], taskTitle: 'T1' },
      t10: { messageId: 'm10', confidence: 'low', reason: 'r', sentAt: 's', subject: 'sub', recipients: ['b@x'], taskTitle: 'T10' },
    };
    await writeCompletionCandidates(store, map);
    expect(JSON.parse(values.get(COMPLETION_CANDIDATES_KEY)!)).toEqual(map);

    // Remove t1 by writing the map without it — t10 is untouched (no boundary bleed).
    const { t1: _drop, ...rest } = await readCompletionCandidates(store);
    void _drop;
    await writeCompletionCandidates(store, rest);
    const after = await readCompletionCandidates(store);
    expect(after.t1).toBeUndefined();
    expect(after.t10).toBeDefined();
  });

  it('supersedes a pending voice proposal by whole-object write', async () => {
    const { store } = fakeStore();
    await writeVoiceProposal(store, { status: 'pending', generatedAt: 'g1', guide: 'first' });
    await writeVoiceProposal(store, { status: 'pending', generatedAt: 'g2', guide: 'second' });
    expect(await readVoiceProposal(store)).toEqual({ status: 'pending', generatedAt: 'g2', guide: 'second' });
    await writeVoiceProposal(store, null);
    expect(await readVoiceProposal(store)).toBeNull();
  });

  it('round-trips an id set', async () => {
    const { store } = fakeStore();
    await writeIdSet(store, ASKED_TASK_IDS_KEY, new Set(['a', 'b']));
    expect([...(await readIdSet(store, ASKED_TASK_IDS_KEY))].sort()).toEqual(['a', 'b']);
  });

  it('round-trips a digest map and flattens to items carrying their taskId', async () => {
    const { store } = fakeStore();
    const map: CompletionDigestMap = {
      t1: { kind: 'undo', taskId: 't1', taskTitle: 'Follow up', note: 'n1' },
      t2: { kind: 'confirm', taskId: 't2', taskTitle: 'Plan AGM', note: 'n2' },
    };
    await writeCompletionDigest(store, map);
    const items = digestMapToItems(await readCompletionDigest(store));
    expect(items).toHaveLength(2);
    expect(items[0]!.taskId).toBe('t1');
    expect(items.find((i) => i.taskId === 't2')!.kind).toBe('confirm');
  });

  it('logs corruption via the provided logger when a stored value fails to parse, and still degrades to empty', async () => {
    // Finding 4: a corrupt stored value used to silently reset to empty with zero
    // observability. readCompletionCandidates must still degrade to {} (skill contract) but
    // now surfaces the corruption through an optional logger so it's not a silent data loss.
    const { store } = fakeStore({ [COMPLETION_CANDIDATES_KEY]: 'not json' });
    const { logger, warnCalls } = fakeLogger();
    const result = await readCompletionCandidates(store, logger);
    expect(result).toEqual({});
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]![1]).toMatch(/failed to parse/);
    // PII fix: the log payload carries only the key and the raw value's length — never the raw
    // content itself (which can hold recipients/subjects/task-titles/proposal text).
    expect(warnCalls[0]![0]).toEqual({ key: COMPLETION_CANDIDATES_KEY, rawLength: 'not json'.length });
    expect(warnCalls[0]![0]).not.toHaveProperty('rawSnippet');
  });

  it('logs corruption and returns {} when a map key holds valid JSON with the wrong top-level shape (an array)', async () => {
    // The value parses fine (JSON.parse succeeds on "[]") but a map key must hold a plain
    // object, not an array — this used to pass straight through as CompletionCandidateMap.
    const { store } = fakeStore({ [COMPLETION_CANDIDATES_KEY]: '[]' });
    const { logger, warnCalls } = fakeLogger();
    const result = await readCompletionCandidates(store, logger);
    expect(result).toEqual({});
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]![1]).toMatch(/failed to parse/);
    expect(warnCalls[0]![0]).toMatchObject({ key: COMPLETION_CANDIDATES_KEY });
  });

  it('logs corruption and returns null when the voice proposal holds valid JSON missing guide/status', async () => {
    const { store } = fakeStore({ [VOICE_PROPOSAL_KEY]: '{"x":1}' });
    const { logger, warnCalls } = fakeLogger();
    const result = await readVoiceProposal(store, logger);
    expect(result).toBeNull();
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]![1]).toMatch(/failed to parse/);
    expect(warnCalls[0]![0]).toMatchObject({ key: VOICE_PROPOSAL_KEY });
  });

  it('does not log corruption for an unset (null) value — absence is not corruption', async () => {
    const { store } = fakeStore();
    const { logger, warnCalls } = fakeLogger();
    const result = await readCompletionCandidates(store, logger);
    expect(result).toEqual({});
    expect(warnCalls).toHaveLength(0);
  });

  it('drops a malformed candidate entry (would crash the consumer) but keeps the valid ones', async () => {
    // `{"bad": {}}` is a structurally-valid map with a malformed value: task-completion would
    // throw on `candidate.recipients[0]`. The reader drops it, keeps the good entry, and logs a
    // PII-safe count (never the dropped content).
    const good = { messageId: 'm1', confidence: 'high', reason: 'r', sentAt: 's', subject: 'sub', recipients: ['a@x'], taskTitle: 'T1' };
    const { store } = fakeStore({
      [COMPLETION_CANDIDATES_KEY]: JSON.stringify({ good, bad: {} }),
    });
    const { logger, warnCalls } = fakeLogger();
    const result = await readCompletionCandidates(store, logger);
    expect(result.good).toEqual(good);
    expect(result.bad).toBeUndefined();
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]![0]).toEqual({ key: COMPLETION_CANDIDATES_KEY, dropped: 1 });
    expect(warnCalls[0]![1]).toMatch(/dropped malformed/);
  });

  it('drops a null digest entry (would crash renderCompletionSection) rather than surfacing it', async () => {
    const { store } = fakeStore({
      [COMPLETION_DIGEST_KEY]: JSON.stringify({ t1: null }),
    });
    const { logger, warnCalls } = fakeLogger();
    const result = await readCompletionDigest(store, logger);
    expect(result).toEqual({});
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]![0]).toEqual({ key: COMPLETION_DIGEST_KEY, dropped: 1 });
  });

  it('drops non-string members from a stored id set (a numeric id would silently bypass the guard)', async () => {
    // `set.has("42")` never matches a numeric 42, so a non-string member would quietly defeat the
    // idempotency guard rather than throw. Drop them, keep the valid string ids, log a count.
    const { store } = fakeStore({
      [ASKED_TASK_IDS_KEY]: JSON.stringify(['a', 42, 'b', null]),
    });
    const { logger, warnCalls } = fakeLogger();
    const result = await readIdSet(store, ASKED_TASK_IDS_KEY, logger);
    expect([...result].sort()).toEqual(['a', 'b']);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]![0]).toEqual({ key: ASKED_TASK_IDS_KEY, dropped: 2 });
    expect(warnCalls[0]![1]).toMatch(/non-string/);
  });

  it('rejects a voice proposal missing generatedAt (incomplete contract)', async () => {
    const { store } = fakeStore({
      [VOICE_PROPOSAL_KEY]: JSON.stringify({ status: 'pending', guide: 'g' }),
    });
    const { logger, warnCalls } = fakeLogger();
    expect(await readVoiceProposal(store, logger)).toBeNull();
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]![0]).toMatchObject({ key: VOICE_PROPOSAL_KEY });
  });

  it('composes undo/confirm note text verbatim to the pre-migration copy', () => {
    expect(composeUndoNote({ taskTitle: 'Ship', recipient: 'a@x', sentAt: '2026-07-01T12:00:00.000Z' }))
      .toBe('Marked *Ship* done — you emailed a@x (2026-07-01). Undo?');
    expect(composeConfirmNote({ taskTitle: 'Ship', recipient: 'a@x' }))
      .toBe('Did emailing a@x complete *Ship*?');
  });
});
