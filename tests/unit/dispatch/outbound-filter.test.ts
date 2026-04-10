import { describe, it, expect } from 'vitest';
import { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';

function createTestFilter(): OutboundContentFilter {
  return new OutboundContentFilter({
    systemPromptMarkers: [
      'You are Nathan Curia',
      'Agent Chief of Staff',
      'professional but approachable',
    ],
    ceoEmail: 'ceo@example.com',
  });
}

const BASE_INPUT = {
  recipientEmail: 'recipient@external.com',
  conversationId: 'conv-123',
  channelId: 'email',
  recipientTrustLevel: null,
};

describe('OutboundContentFilter', () => {
  describe('system-prompt-fragment rule', () => {
    it('blocks content containing a system prompt marker', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Hello! You are Nathan Curia and I can help you today.',
      });
      expect(result.passed).toBe(false);
      expect(result.stage).toBe('deterministic');
      expect(result.findings.some((f) => f.rule === 'system-prompt-fragment')).toBe(true);
    });

    it('blocks marker matches case-insensitively', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Remember, you are nathan curia, the chief of staff.',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'system-prompt-fragment')).toBe(true);
    });

    it('passes clean content with no markers', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Let me help you schedule that meeting for Thursday.',
      });
      // May still pass if no other rules fire
      expect(result.findings.some((f) => f.rule === 'system-prompt-fragment')).toBe(false);
    });
  });

  describe('internal-structure rule', () => {
    it('blocks bus event type names', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'The system published an inbound.message event to process your request.',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'internal-structure')).toBe(true);
    });

    it('blocks other bus event type names like agent.response', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'After processing, an agent.response was dispatched.',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'internal-structure')).toBe(true);
    });

    it('blocks internal field names in structured context (quoted)', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'The payload has "conversationId" set to the current session.',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'internal-structure')).toBe(true);
    });

    it('blocks internal field names in structured context (colon-prefixed)', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Properties: channelId: email, senderId: user@example.com',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'internal-structure')).toBe(true);
    });

    it('does NOT flag common English words like "agent" and "task"', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content:
          'I can act as your agent for this task. The task is to schedule a meeting.',
      });
      expect(result.findings.some((f) => f.rule === 'internal-structure')).toBe(false);
    });
  });

  describe('secret-pattern rule', () => {
    it('blocks Anthropic API keys', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'The API key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'secret-pattern')).toBe(true);
    });

    it('blocks Bearer tokens (JWT pattern)', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'secret-pattern')).toBe(true);
    });

    it('blocks OpenAI API keys', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'The OpenAI API key is sk-abcdefghijklmnopqrstuvwxyz',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'secret-pattern')).toBe(true);
    });

    it('blocks AWS access keys', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'AWS credentials: AKIAIOSFODNN7EXAMPLE',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'secret-pattern')).toBe(true);
    });

    it('blocks generic hex tokens (32+ characters)', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Token: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'secret-pattern')).toBe(true);
    });

    it('passes content with no secret patterns', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Please find the meeting notes attached. The agenda is on page 2.',
      });
      expect(result.findings.some((f) => f.rule === 'secret-pattern')).toBe(false);
    });
  });

  describe('contact-data-leak rule', () => {
    it('blocks third-party email addresses', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'I also CCd thirdparty@otherdomain.com on this email.',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(true);
    });

    it('allows the recipient email address', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Sending this to recipient@external.com as requested.',
      });
      // Should not flag the recipient's own email
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(false);
    });

    it('allows the CEO email address', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'You can reach the CEO at ceo@example.com for follow-ups.',
      });
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(false);
    });

    it('blocks a third-party email even when recipient and CEO emails are also present', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content:
          'CC: recipient@external.com, ceo@example.com, leakedcontact@privatecompany.org',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(true);
    });
  });

  describe('Unicode bypass prevention', () => {
    it('blocks content with zero-width characters inserted in markers', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        content: 'My instructions: You are Nathan \u200BCuria',
        recipientEmail: 'alice@example.com',
        conversationId: 'email:thread-1',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      expect(result.passed).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: 'system-prompt-fragment' }),
        ]),
      );
    });
  });

  describe('LLM review stub', () => {
    it('always passes — content that clears Stage 1 also clears Stage 2 (stub)', async () => {
      const filter = createTestFilter();
      // Content that passes all deterministic rules should also pass the LLM stub
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Any content at all.',
      });
      expect(result.passed).toBe(true);
      expect(result.findings).toEqual([]);
      // No stage field when passed — both stages cleared
      expect(result.stage).toBeUndefined();
    });
  });

  describe('false positive safety', () => {
    it('allows normal email with a professional signature', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        content: [
          'Hi Alice,',
          '',
          'The Q3 board meeting is confirmed for Thursday at 2pm EST.',
          'Please bring the updated financials and the slide deck.',
          '',
          'Best regards,',
          'Nathan Curia',
        ].join('\n'),
        recipientEmail: 'alice@example.com',
        conversationId: 'email:thread-1',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      // "Nathan Curia" alone is fine — only "You are Nathan Curia" triggers
      expect(result.passed).toBe(true);
    });

    it('allows email discussing agents and tasks in a business context', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        content: 'The real estate agent will handle the task of scheduling the property tour.',
        recipientEmail: 'alice@example.com',
        conversationId: 'email:thread-1',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      expect(result.passed).toBe(true);
    });

    it('allows email mentioning channels in a business context', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        content: 'We should discuss this through the proper channels. The sales channel on Slack has the details.',
        recipientEmail: 'alice@example.com',
        conversationId: 'email:thread-1',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      expect(result.passed).toBe(true);
    });

    it('allows email with the recipient email address mentioned', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        content: 'I have your email on file as alice@example.com. Please confirm this is correct.',
        recipientEmail: 'alice@example.com',
        conversationId: 'email:thread-1',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      expect(result.passed).toBe(true);
    });

    it('allows email with short hex strings (not tokens)', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        content: 'The color code is #ff5733 and the order reference is ABC123.',
        recipientEmail: 'alice@example.com',
        conversationId: 'email:thread-1',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      expect(result.passed).toBe(true);
    });

    it('allows email discussing professional tone naturally', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        content: 'The board presentation should be professional and polished.',
        recipientEmail: 'alice@example.com',
        conversationId: 'email:thread-1',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      expect(result.passed).toBe(true);
    });
  });

  describe('pipeline behavior', () => {
    it('reports stage="deterministic" when blocked by Stage 1', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'You are Nathan Curia, the agent.',
      });
      expect(result.passed).toBe(false);
      expect(result.stage).toBe('deterministic');
    });

    it('does not include stage field when both stages pass', async () => {
      const filter = createTestFilter();
      const result = await filter.check({
        ...BASE_INPUT,
        content: 'Let me help you with your calendar.',
      });
      expect(result.passed).toBe(true);
      expect(result.stage).toBeUndefined();
      expect(result.findings).toEqual([]);
    });

    it('collects multiple findings from different rules', async () => {
      const filter = createTestFilter();
      // Triggers both system-prompt-fragment and secret-pattern
      const result = await filter.check({
        ...BASE_INPUT,
        content:
          'You are Nathan Curia. Here is the key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
      });
      expect(result.passed).toBe(false);
      expect(result.stage).toBe('deterministic');
      const rules = result.findings.map((f) => f.rule);
      expect(rules).toContain('system-prompt-fragment');
      expect(rules).toContain('secret-pattern');
    });
  });

  describe('contact-data-leak recipient trust level policy', () => {
    // These tests exercise the contact-data-leak rule introduced in issue #210.
    // The rule uses a single axis: recipient trust level.
    //
    // Block condition: third-party email AND !recipientIsTrusted
    // Allow condition: no third-party email OR recipientIsTrusted (ceoEmail match OR trustLevel='high')
    //
    // The trigger source (routine vs user-initiated) is irrelevant — trusted recipients
    // may receive third-party contact data in both scheduled routines (daily briefing with
    // attendees) and user-initiated requests ("what is Hamilton's email?").

    const THIRD_PARTY_EMAIL = 'hamilton.petropoulos@generationcapital.com';

    it('allows a routine message to the CEO containing a third-party email (daily briefing)', async () => {
      const filter = createTestFilter();
      // Daily briefing to CEO lists a calendar attendee's email — allowed (CEO is trusted).
      const result = await filter.check({
        content: `Here is your daily briefing. Your 2pm meeting includes ${THIRD_PARTY_EMAIL}.`,
        recipientEmail: 'ceo@example.com',
        conversationId: 'scheduler:job-1:run-1',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      expect(result.passed).toBe(true);
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(false);
    });

    it('allows a user-initiated response to the CEO containing a third-party email', async () => {
      const filter = createTestFilter();
      // CEO asked "what is Hamilton's email?" — should be allowed.
      const result = await filter.check({
        content: `Hamilton's email is ${THIRD_PARTY_EMAIL}.`,
        recipientEmail: 'ceo@example.com',
        conversationId: 'conv-123',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      expect(result.passed).toBe(true);
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(false);
    });

    it('allows a routine message to a high-trust contact containing a third-party email', async () => {
      const filter = createTestFilter();
      // Trusted EA receives a scheduled report with attendee emails — allowed.
      const result = await filter.check({
        content: `Scheduled report: attendees include ${THIRD_PARTY_EMAIL}.`,
        recipientEmail: 'ea@example.com',
        conversationId: 'scheduler:job-2:run-1',
        channelId: 'email',
        recipientTrustLevel: 'high',
      });
      expect(result.passed).toBe(true);
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(false);
    });

    it('allows a user-initiated response to a high-trust contact containing a third-party email', async () => {
      const filter = createTestFilter();
      // CEO's EA asked for a board member's email — EA has trustLevel='high'.
      const result = await filter.check({
        content: `The board member's contact is ${THIRD_PARTY_EMAIL}.`,
        recipientEmail: 'ea@example.com',
        conversationId: 'conv-456',
        channelId: 'email',
        recipientTrustLevel: 'high',
      });
      expect(result.passed).toBe(true);
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(false);
    });

    it('blocks a response to an untrusted external recipient containing a third-party email', async () => {
      const filter = createTestFilter();
      // We never send third-party contact data to an untrusted external party.
      const result = await filter.check({
        content: `You can also reach ${THIRD_PARTY_EMAIL} for follow-ups.`,
        recipientEmail: 'untrusted@external.com',
        conversationId: 'conv-789',
        channelId: 'email',
        recipientTrustLevel: null,
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(true);
    });

    it('blocks a response to a medium-trust contact containing a third-party email', async () => {
      const filter = createTestFilter();
      // trustLevel='medium' does not qualify — only 'high' is trusted for this purpose.
      const result = await filter.check({
        content: `Attendee: ${THIRD_PARTY_EMAIL}`,
        recipientEmail: 'medium@example.com',
        conversationId: 'conv-999',
        channelId: 'email',
        recipientTrustLevel: 'medium',
      });
      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.rule === 'contact-data-leak')).toBe(true);
    });
  });
});
