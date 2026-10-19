// The execution layer scrubs tracked sign-in codes out of every tool input
// (default deny, #2017): a code that reached the principal's reply must not be
// persisted by whichever tool an agent hands it to.
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolContext, ToolHandler, ToolManifest, ToolResult } from '../../../src/skills/types.js';
import { CodeTracker } from '../../../src/verification/code-tracker.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';

const logger = pino({ level: 'silent' });

function manifest(name: string, inputs: Record<string, string>): ToolManifest {
  return {
    name,
    description: 'test tool',
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: 'none',
    inputs,
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 5000,
  };
}

class CapturingHandler implements ToolHandler {
  seen: Record<string, unknown> | undefined;
  async execute(ctx: ToolContext): Promise<ToolResult> {
    this.seen = ctx.input;
    return { success: true, data: {} };
  }
}

/** Only `tracker` is read by the execution layer's scrub step. */
function runtime(tracker: CodeTracker): VerificationRuntime {
  return { tracker } as unknown as VerificationRuntime;
}

function setup(toolName: string, inputs: Record<string, string>, tracker?: CodeTracker) {
  const registry = new ToolRegistry();
  const handler = new CapturingHandler();
  registry.register(manifest(toolName, inputs), handler);
  const layer = new ExecutionLayer(registry, logger, tracker ? { verification: runtime(tracker) } : {});
  return { layer, handler };
}

function trackerWithCode(): CodeTracker {
  const tracker = new CodeTracker({ ttlMinutesAfterClose: 120 });
  tracker.register('v1', 'accounts.example.com', '482913');
  return tracker;
}

describe('execution layer sign-in code scrub (#2017)', () => {
  it('task-update progress_note containing a tracked code reaches the handler as [sign-in code]', async () => {
    const { layer, handler } = setup('task-update', { task_id: 'string', progress_note: 'string?' }, trackerWithCode());
    const result = await layer.invoke('task-update', { task_id: 't1', progress_note: 'Principal replied 482913, entering it now' });
    expect(result.success).toBe(true);
    expect(handler.seen?.progress_note).toBe('Principal replied [sign-in code], entering it now');
    expect(handler.seen?.task_id).toBe('t1');
  });

  it("an MCP-registered tool's string input is scrubbed", async () => {
    const { layer, handler } = setup('mcp__notes__append', { payload: 'object' }, trackerWithCode());
    await layer.invoke('mcp__notes__append', { payload: { lines: ['code is 482-913', 'unrelated'] } });
    expect(handler.seen?.payload).toEqual({ lines: ['code is [sign-in code]', 'unrelated'] });
  });

  it('web-browser input is passed through unchanged', async () => {
    const { layer, handler } = setup('web-browser', { text: 'string' }, trackerWithCode());
    await layer.invoke('web-browser', { text: '482913' });
    expect(handler.seen?.text).toBe('482913');
  });

  it('no verification runtime → input unchanged', async () => {
    const { layer, handler } = setup('task-update', { progress_note: 'string?' });
    await layer.invoke('task-update', { progress_note: 'Principal replied 482913' });
    expect(handler.seen?.progress_note).toBe('Principal replied 482913');
  });

  it('does not touch the caller\'s input object', async () => {
    const { layer } = setup('task-update', { progress_note: 'string?' }, trackerWithCode());
    const input = { progress_note: 'code 482913' };
    await layer.invoke('task-update', input);
    expect(input.progress_note).toBe('code 482913');
  });
});
