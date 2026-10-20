// The execution layer scrubs tracked sign-in codes out of every tool input
// (default deny, #2017): a code that reached the principal's reply must not be
// persisted by whichever tool an agent hands it to.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import type { EventBus } from '../../../src/bus/bus.js';
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
  tracker.register('v1', 'accounts.example.com', '482913', 's1');
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

  it('a tracked code in an unparseable timestamp never reaches the log or the error', async () => {
    const lines: string[] = [];
    const capturing = pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } });
    const registry = new ToolRegistry();
    registry.register(manifest('cal-write', { when: 'timestamp' }), new CapturingHandler());
    const layer = new ExecutionLayer(registry, capturing, { verification: runtime(trackerWithCode()) });
    const result = await layer.invoke('cal-write', { when: '482913' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toContain('482913');
      expect(result.error).toContain('[sign-in code]');
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('482913');
  });

  describe('a gated web-browser call never queues an approval carrying a code', () => {
    // web-browser is exempt from the scrub above, and an approval re-runs the stored input,
    // so a code would be stored in the approval row and shown to the approver. Refused instead.
    function gatedBrowser() {
      const registry = new ToolRegistry();
      const handler = new CapturingHandler();
      registry.register({ ...manifest('web-browser', { action: 'string', text: 'string?' }), action_risk: 'medium' }, handler);
      const request = vi.fn(async () => ({ created: true as const, shortRef: 'ab12cd34' }));
      const autonomyService = {
        getConfig: vi.fn(async () => ({ score: 65, band: 'draft-only', updatedAt: new Date(), updatedBy: 'test' })),
      } as unknown as AutonomyService;
      const layer = new ExecutionLayer(registry, logger, {
        verification: runtime(trackerWithCode()),
        autonomyService,
        approvalTrigger: { request } as never,
        bus: { publish: vi.fn(async () => undefined) } as unknown as EventBus,
      });
      return { layer, handler, request };
    }

    it('refuses to queue an approval for a web-browser input holding a tracked code', async () => {
      const { layer, handler, request } = gatedBrowser();
      const result = await layer.invoke(
        'web-browser', { action: 'type', text: '482 913' }, undefined, { taskEventId: 'task-1' },
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/sign-in code/);
        expect(result.error).toMatch(/no approval request was created/i);
        expect(result.error).not.toMatch(/482[ -]?913/);
      }
      expect(request).not.toHaveBeenCalled();
      expect(handler.seen).toBeUndefined();
    });

    it('still queues an approval for a web-browser input with no tracked code', async () => {
      const { layer, request } = gatedBrowser();
      const result = await layer.invoke(
        'web-browser', { action: 'type', text: 'hello' }, undefined, { taskEventId: 'task-1' },
      );
      expect(result.success).toBe(false);
      expect(request).toHaveBeenCalledOnce();
    });
  });

  it('the tier-mode escalation judge sees a web-browser input with the code scrubbed', async () => {
    // web-browser keeps the real code (it must type it), so the judge's description of the
    // action is the one place that has to scrub it itself. Score 100 keeps Gates A and B
    // out; a known-tier originator makes Gate C ask the judge whether the call targets a
    // third party.
    const registry = new ToolRegistry();
    const handler = new CapturingHandler();
    registry.register({ ...manifest('web-browser', { action: 'string', text: 'string?' }), action_risk: 'medium' }, handler);
    const classifyAction = vi.fn(async (_req: { description: string }) => ({
      decision: 'allow' as const, actionClass: 'reversible-external' as const, isThirdPartyFacing: false, reason: 'stub',
    }));
    const layer = new ExecutionLayer(registry, logger, {
      verification: runtime(trackerWithCode()),
      autonomyService: {
        getConfig: vi.fn(async () => ({ score: 100, band: 'full', updatedAt: new Date(), updatedBy: 'test' })),
      } as unknown as AutonomyService,
      escalationJudge: { classifyAction, isEnabled: () => true } as never,
    });

    await layer.invoke('web-browser', { action: 'type', text: '482913' }, undefined, {
      taskMetadata: {
        originator: { contactId: 'c-1', systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'known' },
      },
    });

    expect(classifyAction).toHaveBeenCalledOnce();
    const description = classifyAction.mock.calls[0]![0].description;
    expect(description).toContain('[sign-in code]');
    expect(description).not.toContain('482913');
    // The handler still receives the real code to type.
    expect(handler.seen?.text).toBe('482913');
  });

  it('does not touch the caller\'s input object', async () => {
    const { layer } = setup('task-update', { progress_note: 'string?' }, trackerWithCode());
    const input = { progress_note: 'code 482913' };
    await layer.invoke('task-update', input);
    expect(input.progress_note).toBe('code 482913');
  });
});
