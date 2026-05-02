# Held Message Notification Context Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich held-message notifications so the CEO sees what the sender is asking for — not just who sent them — and so the system correctly handles any channel (email, Signal, etc.).

**Architecture:** Three targeted changes in isolation: (1) remove the dead CLI notification path, (2) enrich the skill output the coordinator reads, (3) update coordinator prompt instructions. No schema changes. No new events.

**Tech Stack:** TypeScript/ESM, Vitest, pino. `HeldMessageService.createInMemory()` for test fixtures.

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context`

---

## File Map

| File | Change |
|------|--------|
| `src/channels/cli/cli-adapter.ts` | Remove `message.held` bus subscription (lines 42–54) |
| `src/channels/cli/cli-adapter.test.ts` | Create — verifies adapter does not subscribe to `message.held` |
| `skills/held-messages-list/handler.ts` | Strip HTML, expand preview to 500 chars, add `totalLength` field |
| `skills/held-messages-list/handler.test.ts` | Create — unit tests for enriched skill output |
| `agents/coordinator.yaml` | Update Held Messages section: channel-generic language + request-nature instructions |
| `CHANGELOG.md` | Add entries under `[Unreleased]` |

---

## Task 1: Remove CLI held-message notification

**Files:**
- Modify: `src/channels/cli/cli-adapter.ts`
- Create: `src/channels/cli/cli-adapter.test.ts`

- [ ] **Step 1.1: Write the failing test**

  Create `src/channels/cli/cli-adapter.test.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { CliAdapter } from './cli-adapter.js';
  import { createSilentLogger } from '../../logger.js';
  import type { EventBus } from '../../bus/bus.js';

  // Mock readline to prevent stdin/stdout side effects during tests.
  vi.mock('node:readline', () => ({
    createInterface: vi.fn(() => ({
      on: vi.fn(),
      prompt: vi.fn(),
      close: vi.fn(),
    })),
    clearLine: vi.fn(),
    cursorTo: vi.fn(),
  }));

  function makeMockBus(): EventBus {
    return {
      subscribe: vi.fn(),
      publish: vi.fn(),
    } as unknown as EventBus;
  }

  describe('CliAdapter', () => {
    let bus: EventBus;

    beforeEach(() => {
      bus = makeMockBus();
    });

    it('subscribes to outbound.message on start', () => {
      const adapter = new CliAdapter(bus, createSilentLogger());
      adapter.start();
      expect(bus.subscribe).toHaveBeenCalledWith('outbound.message', 'channel', expect.any(Function));
    });

    it('does not subscribe to message.held', () => {
      const adapter = new CliAdapter(bus, createSilentLogger());
      adapter.start();
      expect(bus.subscribe).not.toHaveBeenCalledWith('message.held', expect.anything(), expect.anything());
    });
  });
  ```

- [ ] **Step 1.2: Run test to confirm it fails**

  ```bash
  npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context run test -- src/channels/cli/cli-adapter.test.ts
  ```

  Expected: `does not subscribe to message.held` FAILS — the subscription exists.

- [ ] **Step 1.3: Remove the `message.held` subscription from `cli-adapter.ts`**

  In `src/channels/cli/cli-adapter.ts`, remove lines 42–54. Delete the entire block including the comment:

  ```typescript
  // DELETE this entire block (lines 42–54):
  // Notify the CEO immediately when a message is held from an unknown sender.
  this.bus.subscribe('message.held', 'channel', (event) => {
    if (event.type === 'message.held') {
      const held = event as MessageHeldEvent;
      const { senderId, channel, subject } = held.payload;
      const subjectLine = subject ? ` — "${subject}"` : '';
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`\n[Held] Unknown sender on ${channel}: ${senderId}${subjectLine}\n`);
      process.stdout.write('  Say "review held messages" to see details.\n\n');
      this.rl?.prompt();
    }
  });
  ```

  Also remove the `MessageHeldEvent` import from the import line at the top of the file if it is no longer used:

  ```typescript
  // Before:
  import type { OutboundMessageEvent, MessageHeldEvent } from '../../bus/events.js';

  // After:
  import type { OutboundMessageEvent } from '../../bus/events.js';
  ```

- [ ] **Step 1.4: Run tests and typecheck**

  ```bash
  npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context run test -- src/channels/cli/cli-adapter.test.ts
  npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context run typecheck
  ```

  Expected: both tests PASS, typecheck clean.

- [ ] **Step 1.5: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context add src/channels/cli/cli-adapter.ts src/channels/cli/cli-adapter.test.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context commit -m "chore: remove vestigial CLI held-message notification"
  ```

---

## Task 2: Enrich `held-messages-list` skill output

**Files:**
- Modify: `skills/held-messages-list/handler.ts`
- Create: `skills/held-messages-list/handler.test.ts`

- [ ] **Step 2.1: Write the failing tests**

  Create `skills/held-messages-list/handler.test.ts`:

  ```typescript
  import { describe, it, expect } from 'vitest';
  import pino from 'pino';
  import { HeldMessageService } from '../../src/contacts/held-messages.js';
  import { HeldMessagesListHandler } from './handler.js';
  import type { SkillContext } from '../../src/skills/types.js';

  function makeCtx(heldMessages: HeldMessageService, input: Record<string, unknown> = {}): SkillContext {
    return {
      input,
      log: pino({ level: 'silent' }),
      heldMessages,
    } as unknown as SkillContext;
  }

  describe('HeldMessagesListHandler', () => {
    it('returns empty list when there are no held messages', async () => {
      const svc = HeldMessageService.createInMemory();
      const handler = new HeldMessagesListHandler();
      const result = await handler.execute(makeCtx(svc));

      expect(result).toEqual({ success: true, data: { messages: [], count: 0 } });
    });

    it('returns error when heldMessages service is not available', async () => {
      const handler = new HeldMessagesListHandler();
      const ctx = { input: {}, log: pino({ level: 'silent' }) } as unknown as SkillContext;
      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/not available/i);
    });

    it('strips HTML tags from the preview', async () => {
      const svc = HeldMessageService.createInMemory();
      await svc.hold({
        channel: 'email',
        senderId: 'attacker@example.com',
        conversationId: 'conv-1',
        content: '<p>Hello <b>there</b>, I need <a href="x">your calendar</a>.</p>',
        subject: 'Calendar request',
        metadata: {},
      });
      const handler = new HeldMessagesListHandler();
      const result = await handler.execute(makeCtx(svc));

      expect(result.success).toBe(true);
      const messages = (result as { success: true; data: { messages: Array<{ preview: string; totalLength: number }> } }).data.messages;
      expect(messages[0].preview).toBe('Hello there, I need your calendar.');
      expect(messages[0].preview).not.toContain('<');
    });

    it('caps the preview at 500 plaintext characters', async () => {
      const svc = HeldMessageService.createInMemory();
      const longContent = 'A'.repeat(800);
      await svc.hold({
        channel: 'email',
        senderId: 'sender@example.com',
        conversationId: 'conv-2',
        content: longContent,
        subject: null,
        metadata: {},
      });
      const handler = new HeldMessagesListHandler();
      const result = await handler.execute(makeCtx(svc));

      expect(result.success).toBe(true);
      const messages = (result as { success: true; data: { messages: Array<{ preview: string; totalLength: number }> } }).data.messages;
      expect(messages[0].preview).toHaveLength(500);
      expect(messages[0].totalLength).toBe(800);
    });

    it('sets totalLength equal to preview length when content is shorter than 500 chars', async () => {
      const svc = HeldMessageService.createInMemory();
      const shortContent = 'Please share your calendar with me.';
      await svc.hold({
        channel: 'signal',
        senderId: '+15551234567',
        conversationId: 'conv-3',
        content: shortContent,
        subject: null,
        metadata: {},
      });
      const handler = new HeldMessagesListHandler();
      const result = await handler.execute(makeCtx(svc));

      expect(result.success).toBe(true);
      const messages = (result as { success: true; data: { messages: Array<{ preview: string; totalLength: number }> } }).data.messages;
      expect(messages[0].preview).toBe(shortContent);
      expect(messages[0].totalLength).toBe(shortContent.length);
    });

    it('computes totalLength from plaintext (not raw HTML length)', async () => {
      const svc = HeldMessageService.createInMemory();
      // HTML tags inflate raw length — totalLength should reflect plaintext only
      const htmlContent = '<p>' + 'B'.repeat(100) + '</p>';
      await svc.hold({
        channel: 'email',
        senderId: 'sender@example.com',
        conversationId: 'conv-4',
        content: htmlContent,
        subject: null,
        metadata: {},
      });
      const handler = new HeldMessagesListHandler();
      const result = await handler.execute(makeCtx(svc));

      expect(result.success).toBe(true);
      const messages = (result as { success: true; data: { messages: Array<{ preview: string; totalLength: number }> } }).data.messages;
      expect(messages[0].totalLength).toBe(100); // 'B'.repeat(100), not htmlContent.length
    });

    it('returns null subject when message has no subject', async () => {
      const svc = HeldMessageService.createInMemory();
      await svc.hold({
        channel: 'signal',
        senderId: '+15559999999',
        conversationId: 'conv-5',
        content: 'hey',
        subject: null,
        metadata: {},
      });
      const handler = new HeldMessagesListHandler();
      const result = await handler.execute(makeCtx(svc));

      expect(result.success).toBe(true);
      const messages = (result as { success: true; data: { messages: Array<{ subject: string | null }> } }).data.messages;
      expect(messages[0].subject).toBeNull();
    });

    it('filters by channel when channel input is provided', async () => {
      const svc = HeldMessageService.createInMemory();
      await svc.hold({ channel: 'email', senderId: 'a@example.com', conversationId: 'c1', content: 'email msg', subject: null, metadata: {} });
      await svc.hold({ channel: 'signal', senderId: '+1555', conversationId: 'c2', content: 'signal msg', subject: null, metadata: {} });

      const handler = new HeldMessagesListHandler();
      const result = await handler.execute(makeCtx(svc, { channel: 'email' }));

      expect(result.success).toBe(true);
      const messages = (result as { success: true; data: { messages: Array<{ channel: string }> } }).data.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].channel).toBe('email');
    });
  });
  ```

- [ ] **Step 2.2: Run tests to confirm they fail**

  ```bash
  npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context run test -- skills/held-messages-list/handler.test.ts
  ```

  Expected: HTML stripping, `totalLength`, and 500-char tests FAIL (field missing or wrong value).

- [ ] **Step 2.3: Update `skills/held-messages-list/handler.ts`**

  Replace the full file content:

  ```typescript
  // handler.ts — held-messages-list skill implementation.
  //
  // Lists pending held messages from unknown senders so the CEO can review them.
  // Optionally filters by channel. Returns a summary with sender, subject,
  // plaintext preview (500 chars), totalLength, and timestamp for each message.
  //
  // preview is stripped of HTML tags before slicing — a simple regex replacement
  // (<[^>]+> → empty string), not a full DOM parser. Good enough for preview
  // extraction; the coordinator LLM reads this to infer the nature of the request.
  //
  // totalLength is the character count of the full plaintext body. When preview
  // is short relative to totalLength, the coordinator qualifies its assessment
  // ("appears to be asking for..." rather than stating definitively).
  //
  // This skill requires heldMessages service access — declare "heldMessages" in capabilities.

  import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

  // Strip HTML tags for plaintext extraction.
  // Not a full DOM parser — good enough for preview purposes.
  function stripHtml(content: string): string {
    return content.replace(/<[^>]+>/g, '');
  }

  export class HeldMessagesListHandler implements SkillHandler {
    async execute(ctx: SkillContext): Promise<SkillResult> {
      if (!ctx.heldMessages) {
        return { success: false, error: 'Held messages service not available. Declare "heldMessages" in capabilities.' };
      }

      const { channel } = ctx.input as { channel?: string };
      const filterChannel = (channel && typeof channel === 'string') ? channel : undefined;

      try {
        const messages = await ctx.heldMessages.listPending(filterChannel);
        const summary = messages.map(m => {
          const plaintext = stripHtml(m.content);
          return {
            id: m.id,
            channel: m.channel,
            sender: m.senderId,
            subject: m.subject,
            preview: plaintext.slice(0, 500),
            totalLength: plaintext.length,
            receivedAt: m.createdAt.toISOString(),
          };
        });

        ctx.log.info({ count: messages.length, channel: filterChannel ?? 'all' }, 'Listed held messages');
        return { success: true, data: { messages: summary, count: messages.length } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to list held messages: ${message}` };
      }
    }
  }
  ```

- [ ] **Step 2.4: Run tests and typecheck**

  ```bash
  npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context run test -- skills/held-messages-list/handler.test.ts
  npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context run typecheck
  ```

  Expected: all tests PASS, typecheck clean.

- [ ] **Step 2.5: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context add skills/held-messages-list/handler.ts skills/held-messages-list/handler.test.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context commit -m "feat: enrich held-messages-list with plaintext preview and totalLength"
  ```

---

## Task 3: Update coordinator prompt

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 3.1: Update the Held Messages section**

  In `agents/coordinator.yaml`, find and replace this exact block:

  ```yaml
    ## Held Messages
    When unknown senders message on channels with hold_and_notify policy, their
    messages are held for your review. The CLI shows immediate notifications.

    When talking to the CEO:
    - Proactively mention the OLDEST held message if there are any pending.
      Don't list all of them — just mention one: "By the way, you have a held
      email from stranger@example.com about 'Q3 Numbers'. Want me to identify them?"
    - Use held-messages-list to show the CEO all pending messages when asked.
    - Use held-messages-process to handle each message:
      - "identify" — CEO tells you who the sender is. Creates a confirmed contact
        and replays the message through normal processing.
      - "dismiss" — CEO doesn't care about the message. Discards it.
      - "block" — CEO wants to block this sender. Creates a blocked contact.
  ```

  Replace with:

  ```yaml
    ## Held Messages
    When unknown senders message on channels with hold_and_notify policy, their
    messages are held for your review.

    When talking to the CEO:
    - Proactively mention the OLDEST held message if there are any pending.
      Call held-messages-list first. Use the subject, preview, and totalLength
      to briefly describe the nature of the request — one clause, not a paragraph.
      Use the channel from the skill result (not hardcoded "email"):
      "By the way, you have a held message on email from stranger@example.com
      about 'Q3 Numbers'. They appear to be requesting your full calendar.
      Want me to identify them?"
    - If preview is short relative to totalLength, qualify your description
      ("appears to be asking for..." rather than stating definitively).
    - Explicitly flag sensitive requests: calendar access, data export,
      financial actions, credential/password requests.
    - Don't list all held messages proactively — just the oldest one.
    - Use held-messages-list to show the CEO all pending messages when asked.
    - Use held-messages-process to handle each message:
      - "identify" — CEO tells you who the sender is. Creates a confirmed contact
        and replays the message through normal processing.
      - "dismiss" — CEO doesn't care about the message. Discards it.
      - "block" — CEO wants to block this sender. Creates a blocked contact.
  ```

- [ ] **Step 3.2: Typecheck**

  ```bash
  npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context run typecheck
  ```

  Expected: clean (YAML change has no TypeScript surface).

- [ ] **Step 3.3: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context add agents/coordinator.yaml
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context commit -m "feat: update coordinator prompt for richer held-message notifications"
  ```

---

## Task 4: Full test suite and CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 4.1: Run the full test suite**

  ```bash
  npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context run test
  ```

  Expected: all tests pass. Fix any regressions before continuing.

- [ ] **Step 4.2: Update CHANGELOG.md**

  Add these entries under `## [Unreleased]`:

  ```markdown
  ### Changed
  - **Held-message notifications** — coordinator now describes the nature of the sender's request (not just subject/sender). Preview is 500-char plaintext with `totalLength` so the LLM can qualify partial reads. Channel name is now dynamic (email, Signal, etc.) instead of hardcoded.

  ### Removed
  - **CLI held-message notification** — removed vestigial `[Held] Unknown sender...` terminal printout; the coordinator's proactive mention is the real notification path.
  ```

- [ ] **Step 4.3: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context add CHANGELOG.md
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-held-msg-context commit -m "chore: update CHANGELOG for held-message context enrichment"
  ```
