// bedrock.test.ts — tests for the AWS Bedrock (Converse API) LLM provider.
//
// Mocks @aws-sdk/client-bedrock-runtime so tests run without AWS credentials.
// Follows the same pattern as openrouter.test.ts: vi.hoisted mockSend, vi.mock to
// stub the SDK, and createSilentLogger for silent logging.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BedrockProvider,
  detectUncalledToolIntent,
  normalizeMessageSequence,
} from '../../../../src/agents/llm/bedrock.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { Message, ToolDefinition } from '../../../../src/agents/llm/provider.js';

const mockSend = vi.hoisted(() => vi.fn());
const clientConfigs = vi.hoisted(() => [] as unknown[]);

// Only the network client is replaced. ConverseCommand stays the real SDK class, so the
// request the provider builds is a genuine ConverseCommand whose `.input` we can assert on.
vi.mock('@aws-sdk/client-bedrock-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-bedrock-runtime')>()),
  // The provider calls `new BedrockRuntimeClient({ region, credentials })`.
  BedrockRuntimeClient: class {
    constructor(config: unknown) {
      clientConfigs.push(config);
    }
    send = mockSend;
  },
}));

const MODEL = 'global.anthropic.claude-sonnet-4-6';

const textResponse = (text = 'hello from bedrock') => ({
  output: { message: { role: 'assistant', content: [{ text }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
  $metadata: { requestId: 'req-abc-123' },
});

/** A Converse content block, narrowed to the members these tests read. */
interface SentBlock {
  text?: string;
  image?: { format: string; source: { bytes: Uint8Array } };
  toolUse?: unknown;
  toolResult?: unknown;
}

/** The slice of a Converse request these tests assert on. */
interface ConverseRequest {
  modelId: string;
  system?: Array<{ text: string }>;
  messages: Array<{ role: string; content: SentBlock[] }>;
  toolConfig?: unknown;
  inferenceConfig: { maxTokens: number; temperature?: number };
}

/** The Converse request the provider built for the most recent send(). */
function lastRequest(): ConverseRequest {
  const call = mockSend.mock.calls.at(-1);
  expect(call).toBeDefined();
  // The real ConverseCommand exposes its constructor input on `.input`.
  return (call![0] as { input: ConverseRequest }).input;
}

function makeProvider(timeoutMs = 5_000) {
  const logger = createSilentLogger();
  const registry = new ModelRegistry(logger);
  const provider = new BedrockProvider('AKIA-test', 'secret-test', 'ca-central-1', timeoutMs, logger, registry);
  return { provider, logger };
}

const lookupTool: ToolDefinition = {
  name: 'contact-lookup',
  description: 'Find a contact',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

beforeEach(() => {
  mockSend.mockReset();
  clientConfigs.length = 0;
});

describe('BedrockProvider', () => {
  it('identifies itself as "bedrock" and builds the client from the given credentials and region', () => {
    const { provider } = makeProvider();
    expect(provider.id).toBe('bedrock');
    expect(clientConfigs[0]).toEqual({
      region: 'ca-central-1',
      credentials: { accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' },
    });
  });

  describe('text responses', () => {
    it('maps a text response with usage and provenance', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();

      const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL });

      expect(res).toEqual({
        type: 'text',
        content: 'hello from bedrock',
        usage: { inputTokens: 12, outputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: { requestedModel: MODEL, actualModel: MODEL, providerRequestId: 'req-abc-123' },
      });
    });

    it('reports cache token counts when Bedrock returns them', async () => {
      mockSend.mockResolvedValueOnce({
        ...textResponse(),
        usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 900, cacheWriteInputTokens: 40 },
      });
      const { provider } = makeProvider();

      const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL });

      expect(res.type).toBe('text');
      if (res.type === 'text') {
        expect(res.usage.cacheReadInputTokens).toBe(900);
        expect(res.usage.cacheCreationInputTokens).toBe(40);
      }
    });

    it('joins multiple text blocks rather than keeping only the first', async () => {
      mockSend.mockResolvedValueOnce({
        ...textResponse(),
        output: { message: { role: 'assistant', content: [{ text: 'part one, ' }, { text: 'part two' }] } },
      });
      const { provider } = makeProvider();

      const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL });

      expect(res.type === 'text' && res.content).toBe('part one, part two');
    });

    it('accepts the model from options.model when no top-level model is given', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();

      await provider.chat({ messages: [{ role: 'user', content: 'hi' }], options: { model: MODEL } });

      expect(lastRequest().modelId).toBe(MODEL);
    });
  });

  describe('request shape', () => {
    it('concatenates every system message into the dedicated system parameter', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();
      const messages: Message[] = [
        { role: 'system', content: 'main prompt' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'sender context' },
      ];

      await provider.chat({ messages, model: MODEL });

      const req = lastRequest();
      expect(req.system).toEqual([{ text: 'main prompt\n\nsender context' }]);
      expect(req.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
    });

    it('omits the system parameter when there are no system messages', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();

      await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL });

      expect(lastRequest().system).toBeUndefined();
    });

    it('translates tool definitions into a Converse toolConfig', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();

      await provider.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [lookupTool], model: MODEL });

      expect(lastRequest().toolConfig).toEqual({
        tools: [{
          toolSpec: {
            name: 'contact-lookup',
            description: 'Find a contact',
            inputSchema: { json: lookupTool.input_schema },
          },
        }],
      });
    });

    it('sends no toolConfig when no tools are offered', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();

      await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL });

      expect(lastRequest().toolConfig).toBeUndefined();
    });

    it('defaults maxTokens to the model registry limit and clamps a larger caller value to it', async () => {
      mockSend.mockResolvedValue(textResponse());
      const { provider } = makeProvider();
      const messages: Message[] = [{ role: 'user', content: 'hi' }];

      await provider.chat({ messages, model: MODEL });
      const registryMax = lastRequest().inferenceConfig.maxTokens as number;
      expect(registryMax).toBeGreaterThan(0);

      await provider.chat({ messages, model: MODEL, options: { max_tokens: 100 } });
      expect(lastRequest().inferenceConfig.maxTokens).toBe(100);

      await provider.chat({ messages, model: MODEL, options: { max_tokens: registryMax * 10 } });
      expect(lastRequest().inferenceConfig.maxTokens).toBe(registryMax);
    });

    it('passes a numeric temperature through, including 0', async () => {
      mockSend.mockResolvedValue(textResponse());
      const { provider } = makeProvider();
      const messages: Message[] = [{ role: 'user', content: 'hi' }];

      await provider.chat({ messages, model: MODEL, options: { temperature: 0 } });
      expect(lastRequest().inferenceConfig.temperature).toBe(0);

      await provider.chat({ messages, model: MODEL, options: { temperature: 0.4 } });
      expect(lastRequest().inferenceConfig.temperature).toBe(0.4);
    });

    it('omits temperature when unset, non-numeric, or outside the 0–1 range Bedrock accepts', async () => {
      mockSend.mockResolvedValue(textResponse());
      const { provider, logger } = makeProvider();
      const warn = vi.spyOn(logger, 'warn');
      const messages: Message[] = [{ role: 'user', content: 'hi' }];

      await provider.chat({ messages, model: MODEL });
      expect('temperature' in lastRequest().inferenceConfig).toBe(false);

      await provider.chat({ messages, model: MODEL, options: { temperature: 'hot' } });
      expect('temperature' in lastRequest().inferenceConfig).toBe(false);

      warn.mockClear();
      await provider.chat({ messages, model: MODEL, options: { temperature: 1.5 } });
      expect('temperature' in lastRequest().inferenceConfig).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ temperature: 1.5 }), expect.stringContaining('outside the 0–1 range'));
    });
  });

  describe('tool use', () => {
    it('maps toolUse blocks to tool calls, keeping any text preamble', async () => {
      mockSend.mockResolvedValueOnce({
        ...textResponse(),
        stopReason: 'tool_use',
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: 'Looking that up.' },
              { toolUse: { toolUseId: 'tu-1', name: 'contact-lookup', input: { query: 'Ada' } } },
              { toolUse: { toolUseId: 'tu-2', name: 'contact-lookup', input: { query: 'Grace' } } },
            ],
          },
        },
      });
      const { provider } = makeProvider();

      const res = await provider.chat({ messages: [{ role: 'user', content: 'who?' }], tools: [lookupTool], model: MODEL });

      expect(res.type).toBe('tool_use');
      if (res.type === 'tool_use') {
        expect(res.content).toBe('Looking that up.');
        expect(res.toolCalls).toEqual([
          { id: 'tu-1', name: 'contact-lookup', input: { query: 'Ada' } },
          { id: 'tu-2', name: 'contact-lookup', input: { query: 'Grace' } },
        ]);
      }
    });

    it('leaves content undefined when a tool call has no text preamble', async () => {
      mockSend.mockResolvedValueOnce({
        ...textResponse(),
        output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu-1', name: 'contact-lookup', input: {} } }] } },
      });
      const { provider } = makeProvider();

      const res = await provider.chat({ messages: [{ role: 'user', content: 'who?' }], tools: [lookupTool], model: MODEL });

      expect(res.type === 'tool_use' && res.content).toBeUndefined();
    });

    it('round-trips tool_use and tool_result blocks from history, including the error status', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();
      const messages: Message[] = [
        { role: 'user', content: 'who is Ada?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'contact-lookup', input: { query: 'Ada' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'boom', is_error: true }] },
      ];

      await provider.chat({ messages, tools: [lookupTool], model: MODEL });

      expect(lastRequest().messages).toEqual([
        { role: 'user', content: [{ text: 'who is Ada?' }] },
        { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu-1', name: 'contact-lookup', input: { query: 'Ada' } } }] },
        { role: 'user', content: [{ toolResult: { toolUseId: 'tu-1', content: [{ text: 'boom' }], status: 'error' } }] },
      ]);
    });

    it('appends the legacy toolResults parameter as a user turn', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();
      const messages: Message[] = [
        { role: 'user', content: 'who is Ada?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'contact-lookup', input: {} }] },
      ];

      await provider.chat({ messages, model: MODEL, toolResults: [{ id: 'tu-1', content: 'Ada Lovelace' }] });

      expect(lastRequest().messages.at(-1)).toEqual({
        role: 'user',
        content: [{ toolResult: { toolUseId: 'tu-1', content: [{ text: 'Ada Lovelace' }], status: 'success' } }],
      });
    });
  });

  describe('images', () => {
    it('sends a base64 image as raw bytes with the matching format', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();
      const data = Buffer.from('not-really-a-png').toString('base64');

      await provider.chat({
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        ] }],
        model: MODEL,
      });

      const image = lastRequest().messages[0]!.content[1]!.image!;
      expect(image.format).toBe('png');
      expect(Buffer.from(image.source.bytes).toString()).toBe('not-really-a-png');
    });

    it('drops a URL image with a warning and keeps the rest of the message', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider, logger } = makeProvider();
      const warn = vi.spyOn(logger, 'warn');

      await provider.chat({
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        ] }],
        model: MODEL,
      });

      expect(lastRequest().messages[0].content).toEqual([{ text: 'what is this?' }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('URL source is not supported'));
    });

    it('drops a message whose only block was an unsupported URL image, instead of sending empty content', async () => {
      mockSend.mockResolvedValueOnce(textResponse());
      const { provider } = makeProvider();

      await provider.chat({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] },
          { role: 'user', content: 'second' },
        ],
        model: MODEL,
      });

      // The empty assistant turn is gone and the two user turns are merged by the
      // alternation normalizer, so Converse never sees an empty content array.
      const sent = lastRequest().messages as Array<{ content: unknown[] }>;
      expect(sent.every((m) => m.content.length > 0)).toBe(true);
    });
  });

  describe('failure handling (chat never throws)', () => {
    it('returns an error response when no model is given', async () => {
      const { provider } = makeProvider();

      const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });

      expect(res.type).toBe('error');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns a classified error response when the SDK call rejects', async () => {
      mockSend.mockRejectedValueOnce(new Error('ValidationException: bare model id not supported'));
      const { provider } = makeProvider();

      const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL });

      expect(res.type).toBe('error');
      if (res.type === 'error') {
        expect(res.error.source).toBe('bedrock');
      }
    });

    it('aborts the request and returns an error when the timeout elapses', async () => {
      mockSend.mockImplementationOnce((_cmd: unknown, opts: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
        opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const { provider } = makeProvider(20);

      const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL });

      expect(res.type).toBe('error');
    });

    it('aborts the request when the caller signal fires, and still returns an error response', async () => {
      mockSend.mockImplementationOnce((_cmd: unknown, opts: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
        opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const { provider } = makeProvider();
      const caller = new AbortController();

      const pending = provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL, options: { signal: caller.signal } });
      caller.abort();

      expect((await pending).type).toBe('error');
    });

    it('aborts without hanging when the caller signal was already aborted before the call', async () => {
      mockSend.mockImplementationOnce((_cmd: unknown, opts: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
        // The signal handed to the SDK must already be aborted; a listener added now would never fire.
        if (opts.abortSignal.aborted) reject(new Error('aborted'));
      }));
      const { provider } = makeProvider();

      const res = await provider.chat({
        messages: [{ role: 'user', content: 'hi' }],
        model: MODEL,
        options: { signal: AbortSignal.abort() },
      });

      expect(res.type).toBe('error');
    });

    it('logs an error when the model returns an empty text response', async () => {
      mockSend.mockResolvedValueOnce({ ...textResponse(), output: { message: { role: 'assistant', content: [] } } });
      const { provider, logger } = makeProvider();
      const error = vi.spyOn(logger, 'error');

      const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL });

      expect(res.type === 'text' && res.content).toBe('');
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL }), 'LLM returned empty text response');
    });
  });

  describe('narrated tool calls', () => {
    it('logs loudly when the model describes an offered tool call as JSON instead of invoking it', async () => {
      const narrated = 'I will check.\n```json\n{"name": "contact-lookup", "input": {"query": "Ada"}}\n```';
      mockSend.mockResolvedValueOnce(textResponse(narrated));
      const { provider, logger } = makeProvider();
      const error = vi.spyOn(logger, 'error');

      const res = await provider.chat({ messages: [{ role: 'user', content: 'who?' }], tools: [lookupTool], model: MODEL });

      expect(res.type).toBe('text');
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ uncalledTool: 'contact-lookup' }),
        expect.stringContaining('instead of invoking it'),
      );
    });

    it('does not flag the same text when no tools were offered', async () => {
      mockSend.mockResolvedValueOnce(textResponse('```json\n{"name": "contact-lookup"}\n```'));
      const { provider, logger } = makeProvider();
      const error = vi.spyOn(logger, 'error');

      await provider.chat({ messages: [{ role: 'user', content: 'who?' }], model: MODEL });

      expect(error).not.toHaveBeenCalled();
    });
  });
});

describe('detectUncalledToolIntent', () => {
  const offered = ['contact-lookup', 'email-send'];

  it('finds a fenced JSON object naming an offered tool', () => {
    expect(detectUncalledToolIntent('```json\n{"name":"email-send"}\n```', offered)).toBe('email-send');
    expect(detectUncalledToolIntent('```\n{"name":"contact-lookup"}\n```', offered)).toBe('contact-lookup');
  });

  it('reports a non-JSON fence at debug level rather than swallowing it silently', () => {
    const logger = createSilentLogger();
    const debug = vi.spyOn(logger, 'debug');
    expect(detectUncalledToolIntent('```json\n{not json}\n```', offered, logger)).toBeUndefined();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('ignores a tool name that was not offered, non-JSON fences, arrays and plain mentions', () => {
    expect(detectUncalledToolIntent('```json\n{"name":"rm-rf"}\n```', offered)).toBeUndefined();
    expect(detectUncalledToolIntent('```ts\nconst x = 1;\n```', offered)).toBeUndefined();
    expect(detectUncalledToolIntent('```json\n[{"name":"email-send"}]\n```', offered)).toBeUndefined();
    expect(detectUncalledToolIntent('I could use email-send for that.', offered)).toBeUndefined();
  });
});

describe('normalizeMessageSequence', () => {
  const logger = createSilentLogger();
  const user = (text: string) => ({ role: 'user' as const, content: [{ text }] });
  const assistant = (text: string) => ({ role: 'assistant' as const, content: [{ text }] });

  it('leaves a well-formed alternating sequence untouched', () => {
    const seq = [user('a'), assistant('b'), user('c')];
    expect(normalizeMessageSequence(seq, logger)).toEqual(seq);
  });

  it('drops leading non-user messages', () => {
    expect(normalizeMessageSequence([assistant('x'), assistant('y'), user('a')], logger)).toEqual([user('a')]);
  });

  it('merges consecutive same-role messages, preserving order', () => {
    expect(normalizeMessageSequence([user('a'), user('b'), assistant('c')], logger)).toEqual([
      { role: 'user', content: [{ text: 'a' }, { text: 'b' }] },
      assistant('c'),
    ]);
  });

  it('does not mutate its input', () => {
    const first = user('a');
    normalizeMessageSequence([first, user('b')], logger);
    expect(first.content).toEqual([{ text: 'a' }]);
  });

  it('returns an empty sequence when there is no user message at all', () => {
    expect(normalizeMessageSequence([assistant('x')], logger)).toEqual([]);
  });
});
