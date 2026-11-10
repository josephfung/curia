import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createToolResult, type ToolResultEvent } from '../../../src/bus/events.js';
import type { LLMProvider, LLMResponse } from '../../../src/agents/llm/provider.js';
import { DescriberLearner, parseLearnedWords, RETRY_AFTER_MS } from '../../../src/activity/describer-learner.js';
import { describerHash, type LearnedDescriber, type ToolFacts } from '../../../src/activity/learned-describers.js';
import { createSilentLogger } from '../../../src/logger.js';

function textResponse(content: string): LLMResponse {
  return {
    type: 'text',
    content,
    usage: { inputTokens: 10, outputTokens: 5 },
    provenance: { requestedModel: 'fast', actualModel: 'fast' },
  } as unknown as LLMResponse;
}

/** The expenses agent's context, as the learner hashes it. */
const EXPENSES = 'Tracks the principal\'s expenses in a sheet';

const GOOD = JSON.stringify({ effect: 'write', verb: 'Logged', one: 'an expense', many: 'expenses', attempt: 'log an expense' });

const TOOLS: Record<string, ToolFacts> = {
  'sheet-append': { name: 'sheet-append', description: 'Append a row to a spreadsheet', inputSchema: { type: 'object' }, actionRisk: 'none', mcp: true },
  'sheet-read': { name: 'sheet-read', description: 'Read rows', inputSchema: {}, actionRisk: 'high', mcp: true, readOnlyHint: true },
  'custom-payment': { name: 'custom-payment', description: 'Pay a vendor', inputSchema: {}, actionRisk: 'critical', mcp: false },
  'calendar-free-busy': { name: 'calendar-free-busy', description: 'Free/busy', inputSchema: {}, actionRisk: 'none', mcp: false },
  'tool-a': { name: 'tool-a', description: 'Append a row', inputSchema: {}, actionRisk: 'none', mcp: true },
  'tool-b': { name: 'tool-b', description: 'Append a row', inputSchema: {}, actionRisk: 'none', mcp: true },
  'tool-c': { name: 'tool-c', description: 'Append a row', inputSchema: {}, actionRisk: 'none', mcp: true },
  'quote"tool': { name: 'quote"tool', description: 'Append a row', inputSchema: {}, actionRisk: 'none', mcp: true },
};

function setup(llmResults: Array<LLMResponse | Error>, existing: LearnedDescriber[] = [], agentContext?: (agentId: string) => string | null) {
  const logger = createSilentLogger();
  const bus = new EventBus(logger);
  const chat = vi.fn();
  for (const result of llmResults) {
    if (result instanceof Error) chat.mockRejectedValueOnce(result);
    else chat.mockResolvedValueOnce(result);
  }
  const llm: LLMProvider = { id: 'mock', chat } as unknown as LLMProvider;
  const rows = new Map(existing.map((r) => [`${r.agentId}|${r.toolName}`, r]));
  const repo = {
    get: vi.fn(async (agentId: string, toolName: string) => rows.get(`${agentId}|${toolName}`) ?? null),
    upsert: vi.fn(async (row: LearnedDescriber) => { rows.set(`${row.agentId}|${row.toolName}`, row); return true; }),
    delete: vi.fn(async (agentId: string, toolName: string) => {
      const row = rows.get(`${agentId}|${toolName}`);
      if (!row || row.source === 'operator') return false;
      return rows.delete(`${agentId}|${toolName}`);
    }),
  };
  let clock = 1_000_000;
  const learner = new DescriberLearner({
    bus,
    llm,
    model: 'fast-model',
    repo,
    toolFacts: (name) => TOOLS[name] ?? null,
    agentContext: agentContext ?? ((agentId) => (agentId === 'expenses' ? EXPENSES : null)),
    logger,
    now: () => clock,
  });
  return { bus, chat, repo, rows, learner, advance: (ms: number) => { clock += ms; } };
}

function result(toolName: string, agentId = 'expenses', ok = true): ToolResultEvent {
  return createToolResult({
    agentId,
    conversationId: 'conv-1',
    toolName,
    result: ok ? { success: true, data: { amount: 42 } } : { success: false, error: 'quota' },
    durationMs: 10,
    parentEventId: 'invoke-1',
  });
}

describe('DescriberLearner', () => {
  it('learns once per agent and tool, even when several results arrive at once', async () => {
    const { chat, repo, rows, learner } = setup([textResponse(GOOD)]);
    await Promise.all([learner.handleResult(result('sheet-append')), learner.handleResult(result('sheet-append'))]);
    await learner.handleResult(result('sheet-append'));
    expect(chat).toHaveBeenCalledOnce();
    expect(repo.upsert).toHaveBeenCalledOnce();
    expect(rows.get('expenses|sheet-append')).toMatchObject({
      effect: 'write', verb: 'logged', one: 'an expense', many: 'expenses', attempt: 'log an expense',
      source: 'learned', descriptionHash: describerHash(TOOLS['sheet-append']!, EXPENSES),
    });
  });

  it('learns from the bus subscription', async () => {
    const { bus, chat, learner } = setup([textResponse(GOOD)]);
    learner.register();
    await bus.publish('execution', result('sheet-append'));
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
  });

  it('wraps the tool and agent text as data and asks a short no-reasoning call', async () => {
    const { chat, learner } = setup([textResponse(GOOD)]);
    await learner.handleResult(result('sheet-append'));
    const request = chat.mock.calls[0]![0];
    expect(request).toMatchObject({ model: 'fast-model', options: { max_tokens: 150 } });
    const user = request.messages[1].content as string;
    expect(user).toContain('<agent>Tracks the principal\'s expenses in a sheet</agent>');
    expect(user).toContain('Append a row to a spreadsheet');
    // Call data (the amount in the result) never reaches the prompt.
    expect(user).not.toContain('42');
  });

  it('escapes a double quote in the tool name so it cannot end the name attribute', async () => {
    const { chat, learner } = setup([textResponse(GOOD)]);
    await learner.handleResult(result('quote"tool'));
    const user = chat.mock.calls[0]![0].messages[1].content as string;
    expect(user).toContain('<tool name="quote&quot;tool">');
  });

  it('keeps a deterministic effect over the model\'s answer and records it as a hint', async () => {
    const readAnswer = JSON.stringify({ effect: 'write', verb: 'checked', one: 'the expense sheet', many: 'expense sheets', attempt: 'check the expense sheet' });
    const { chat, rows, learner } = setup([textResponse(readAnswer)]);
    await learner.handleResult(result('sheet-read'));
    expect(rows.get('expenses|sheet-read')).toMatchObject({ effect: 'read', source: 'hint' });
    expect(chat.mock.calls[0]![0].messages[1].content).toContain('This tool only reads.');
  });

  it('skips tools described in code, unknown tools, and reads the feed already names by family', async () => {
    const { chat, learner } = setup([]);
    await learner.handleResult(result('email-archive'));
    await learner.handleResult(result('not-registered'));
    await learner.handleResult(result('calendar-free-busy'));
    expect(chat).not.toHaveBeenCalled();
  });

  it('leaves an operator row and a current row alone, and relearns when the tool changed', async () => {
    const base = { verb: 'x', one: 'y', many: 'z', attempt: 'w', effect: 'write' as const };
    const { chat, rows, learner } = setup([textResponse(GOOD)], [
      { agentId: 'ops', toolName: 'sheet-append', descriptionHash: 'stale', source: 'operator', ...base },
      { agentId: 'expenses', toolName: 'custom-payment', descriptionHash: describerHash(TOOLS['custom-payment']!, EXPENSES), source: 'hint', ...base },
      { agentId: 'expenses', toolName: 'sheet-append', descriptionHash: 'stale', source: 'learned', ...base },
    ]);
    await learner.handleResult(result('sheet-append', 'ops'));
    await learner.handleResult(result('custom-payment'));
    expect(chat).not.toHaveBeenCalled();
    await learner.handleResult(result('sheet-append'));
    expect(chat).toHaveBeenCalledOnce();
    expect(rows.get('expenses|sheet-append')).toMatchObject({ verb: 'logged' });
    expect(rows.get('ops|sheet-append')).toMatchObject({ verb: 'x', source: 'operator' });
  });

  it('relearns a row when the deterministic signal changes without the description changing', async () => {
    // Learned as a read while the server sent no hints; the server then adds readOnlyHint: false.
    const unhinted: ToolFacts = { ...TOOLS['sheet-append']!, readOnlyHint: undefined };
    const stale: LearnedDescriber = {
      agentId: 'expenses', toolName: 'sheet-append', effect: 'read', verb: 'checked', one: 'the sheet', many: 'the sheet',
      attempt: 'check the sheet', descriptionHash: describerHash(unhinted, EXPENSES), source: 'learned',
    };
    TOOLS['sheet-append'] = { ...unhinted, readOnlyHint: false };
    try {
      const { chat, rows, learner } = setup([textResponse(GOOD)], [stale]);
      await learner.handleResult(result('sheet-append', 'expenses', false));
      expect(chat).toHaveBeenCalledOnce();
      expect(rows.get('expenses|sheet-append')).toMatchObject({ effect: 'write', verb: 'logged', source: 'hint' });
    } finally {
      TOOLS['sheet-append'] = unhinted;
    }
  });

  it('writes no row when the call fails, and tries again only after the retry interval', async () => {
    const { chat, repo, learner, advance } = setup([new Error('fast tier down'), textResponse('not json'), textResponse(GOOD)]);
    await learner.handleResult(result('sheet-append'));
    expect(repo.upsert).not.toHaveBeenCalled();
    await learner.handleResult(result('sheet-append'));
    expect(chat).toHaveBeenCalledOnce();
    advance(RETRY_AFTER_MS);
    await learner.handleResult(result('sheet-append'));
    expect(repo.upsert).not.toHaveBeenCalled();
    advance(RETRY_AFTER_MS);
    await learner.handleResult(result('sheet-append'));
    expect(chat).toHaveBeenCalledTimes(3);
    expect(repo.upsert).toHaveBeenCalledOnce();
  });
  it('deletes a write row when the tool becomes a family-named read, and learns nothing', async () => {
    // calendar-free-busy is a read the feed names by family; it was once learned as a write.
    const wasWrite: LearnedDescriber = {
      agentId: 'expenses', toolName: 'calendar-free-busy', effect: 'write', verb: 'booked', one: 'a slot', many: 'slots',
      attempt: 'book a slot', descriptionHash: 'old', source: 'learned',
    };
    const { chat, repo, rows, learner } = setup([], [wasWrite]);
    await learner.handleResult(result('calendar-free-busy'));
    expect(repo.delete).toHaveBeenCalledWith('expenses', 'calendar-free-busy');
    expect(rows.has('expenses|calendar-free-busy')).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });

  it('removes a row its signal contradicts before relearning, so a failed relearn leaves the fallback', async () => {
    const unhinted: ToolFacts = { ...TOOLS['sheet-append']!, readOnlyHint: undefined };
    const staleRead: LearnedDescriber = {
      agentId: 'expenses', toolName: 'sheet-append', effect: 'read', verb: 'checked', one: 'the sheet', many: 'the sheet',
      attempt: 'check the sheet', descriptionHash: describerHash(unhinted, EXPENSES), source: 'learned',
    };
    TOOLS['sheet-append'] = { ...unhinted, readOnlyHint: false };
    try {
      const { repo, rows, learner } = setup([new Error('fast tier down')], [staleRead]);
      await learner.handleResult(result('sheet-append', 'expenses', false));
      expect(repo.upsert).not.toHaveBeenCalled();
      expect(rows.has('expenses|sheet-append')).toBe(false);
    } finally {
      TOOLS['sheet-append'] = unhinted;
    }
  });

  it('keeps an operator row its signal contradicts', async () => {
    const operatorWrite: LearnedDescriber = {
      agentId: 'expenses', toolName: 'calendar-free-busy', effect: 'write', verb: 'booked', one: 'a slot', many: 'slots',
      attempt: 'book a slot', descriptionHash: 'old', source: 'operator',
    };
    const { repo, rows, learner } = setup([], [operatorWrite]);
    await learner.handleResult(result('calendar-free-busy'));
    expect(repo.delete).not.toHaveBeenCalled();
    expect(rows.get('expenses|calendar-free-busy')).toMatchObject({ source: 'operator' });
  });

  it('relearns when the agent is repurposed, with the same tool', async () => {
    let context = EXPENSES;
    const current: LearnedDescriber = {
      agentId: 'expenses', toolName: 'sheet-append', effect: 'write', verb: 'logged', one: 'an expense', many: 'expenses',
      attempt: 'log an expense', descriptionHash: describerHash(TOOLS['sheet-append']!, EXPENSES), source: 'learned',
    };
    const { chat, learner } = setup([textResponse(GOOD)], [current], () => context);
    await learner.handleResult(result('sheet-append'));
    expect(chat).not.toHaveBeenCalled();
    context = 'Books the principal\'s travel';
    // A new process (restart): the pair is not settled in memory.
    const again = setup([textResponse(GOOD)], [current], () => context);
    await again.learner.handleResult(result('sheet-append'));
    expect(again.chat).toHaveBeenCalledOnce();
  });

  it('runs at most two learns at once; a third waits for a slot', async () => {
    const releases: Array<() => void> = [];
    const { chat, learner } = setup([]);
    chat.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve(textResponse(GOOD))); }));
    const runs = ['tool-a', 'tool-b', 'tool-c'].map((t) => learner.handleResult(result(t)));
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    // Give the third every chance to start early.
    await new Promise((r) => setTimeout(r, 20));
    expect(chat).toHaveBeenCalledTimes(2);
    releases.shift()!();
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(3));
    while (releases.length) releases.shift()!();
    await Promise.all(runs);
  });

  it('drops a learn past the queue cap, writes no row for it, and retries it only after the interval', async () => {
    const MAX_IN_FLIGHT = 2;
    const MAX_QUEUED = 50;
    const names = Array.from({ length: MAX_IN_FLIGHT + MAX_QUEUED + 1 }, (_, i) => `bulk-${i}`);
    for (const name of names) TOOLS[name] = { name, description: 'Append a row', inputSchema: {}, actionRisk: 'none', mcp: true };
    try {
      const releases: Array<() => void> = [];
      const { chat, rows, learner, advance } = setup([]);
      chat.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve(textResponse(GOOD))); }));
      const runs = names.map((n) => learner.handleResult(result(n)));
      const overflow = names[names.length - 1]!;
      // The overflow call settles on its own (dropped), while the others are still held.
      await runs[runs.length - 1];
      expect(chat).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
      // Drain everything else.
      while (chat.mock.calls.length < names.length - 1 || releases.length) {
        if (releases.length) releases.shift()!();
        await new Promise((r) => setTimeout(r, 0));
      }
      await Promise.all(runs);
      expect(rows.has(`expenses|${overflow}`)).toBe(false);
      expect(chat).toHaveBeenCalledTimes(names.length - 1);
      // Not retried inside the interval; retried after it.
      await learner.handleResult(result(overflow));
      expect(chat).toHaveBeenCalledTimes(names.length - 1);
      advance(RETRY_AFTER_MS);
      chat.mockResolvedValueOnce(textResponse(GOOD));
      await learner.handleResult(result(overflow));
      expect(chat).toHaveBeenCalledTimes(names.length);
      expect(rows.has(`expenses|${overflow}`)).toBe(true);
    } finally {
      for (const name of names) delete TOOLS[name];
    }
  });
});

describe('parseLearnedWords', () => {
  it('reads JSON inside a fence and lower-cases the words', () => {
    expect(parseLearnedWords('```json\n' + GOOD + '\n```', 'sheet-append')).toEqual({
      effect: 'write', verb: 'logged', one: 'an expense', many: 'expenses', attempt: 'log an expense',
    });
  });

  it.each([
    ['a figure', { one: '42 expenses' }],
    ['the tool name', { one: 'a sheet-append row' }],
    ['identifier punctuation', { one: 'a sheet_row' }],
    ['an email address', { one: 'ada@example.com' }],
    ['a missing field', { attempt: undefined }],
    ['an unknown effect', { effect: 'delete' }],
    ['an over-long phrase', { verb: 'logged and then carefully reconciled' }],
  ])('rejects %s', (_label, change) => {
    const answer = { ...JSON.parse(GOOD), ...change };
    expect(parseLearnedWords(JSON.stringify(answer), 'sheet-append')).toBeNull();
  });

  it('rejects text that is not JSON', () => {
    expect(parseLearnedWords('logged an expense', 'sheet-append')).toBeNull();
    expect(parseLearnedWords('{not json}', 'sheet-append')).toBeNull();
  });
});
