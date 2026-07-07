// bedrock-mistral.test.ts — tests for the AWS Bedrock (Mistral) LLM provider.
//
// Mocks BedrockRuntimeClient.send() so tests run without real AWS credentials.
// ConverseCommand is left as the real SDK class (a plain data container with
// an `.input` property) — only the client's network call needs stubbing.
// Follows the same pattern as anthropic.test.ts / openrouter.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BedrockMistralProvider } from './bedrock-mistral.js';
import { ModelRegistry } from './model-registry.js';
import { createSilentLogger } from '../../logger.js';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-bedrock-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-bedrock-runtime')>();
  return {
    ...actual,
    // BedrockMistralProvider calls `new BedrockRuntimeClient({...})` in its
    // constructor and `this.client.send(command, opts)` in chat().
    BedrockRuntimeClient: class {
      send = mockSend;
    },
  };
});

const MODEL = 'mistral.mistral-large-2402-v1:0';

// A valid text-only Converse API response shape.
const makeTextResponse = () => ({
  output: { message: { role: 'assistant', content: [{ text: 'hello from bedrock' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  $metadata: { requestId: 'req-test-123' },
});

function makeProvider(logger = createSilentLogger()) {
  return new BedrockMistralProvider(
    'test-access-key',
    'test-secret-key',
    'ca-central-1',
    120000,
    logger,
    new ModelRegistry(logger),
  );
}

describe('BedrockMistralProvider', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue(makeTextResponse());
  });

  it('returns correct LLMResponse shape for a text response with usage and provenance', async () => {
    const provider = makeProvider();
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: MODEL,
    });

    expect(result.type).toBe('text');
    if (result.type !== 'text') return;

    expect(result.content).toBe('hello from bedrock');

    // No prompt-cache support on Bedrock Mistral — cache fields always 0.
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    // Converse doesn't report a distinct "actual model" — requested === actual.
    expect(result.provenance.requestedModel).toBe(MODEL);
    expect(result.provenance.actualModel).toBe(MODEL);
    expect(result.provenance.providerRequestId).toBe('req-test-123');
  });

  it('maps tool calls to Curia ToolCall shape', async () => {
    mockSend.mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 'call_abc123', name: 'search', input: { query: 'test' } } }],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      $metadata: { requestId: 'req-tool-456' },
    });

    const provider = makeProvider();
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Search something' }],
      model: MODEL,
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object', properties: {} } }],
    });

    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') return;

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'call_abc123',
      name: 'search',
      input: { query: 'test' },
    });
    expect(result.content).toBeUndefined();

    // Assert the tool spec was actually sent to Converse in the expected shape.
    const command = mockSend.mock.calls[0]![0] as { input: { toolConfig?: { tools: unknown[] } } };
    expect(command.input.toolConfig?.tools).toEqual([
      { toolSpec: { name: 'search', description: 'Search', inputSchema: { json: { type: 'object', properties: {} } } } },
    ]);
  });

  it('handles mixed response (text + tool calls)', async () => {
    mockSend.mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [
            { text: 'Let me look that up for you.' },
            { toolUse: { toolUseId: 'call_def456', name: 'lookup', input: { id: '42' } } },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 15, outputTokens: 8, totalTokens: 23 },
      $metadata: { requestId: 'req-mixed-789' },
    });

    const provider = makeProvider();
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Look up item 42' }],
      model: MODEL,
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } }],
    });

    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') return;

    expect(result.content).toBe('Let me look that up for you.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('lookup');
    expect(result.toolCalls[0]!.input).toEqual({ id: '42' });
  });

  it('catches exceptions and returns classified error response', async () => {
    const apiError = Object.assign(new Error('ValidationException: The provided model identifier is invalid.'), { $fault: 'client' });
    mockSend.mockRejectedValue(apiError);

    const provider = makeProvider();
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: MODEL,
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') return;
    expect(result.error.source).toBe('bedrock');
  });

  it('returns error when no model is provided', async () => {
    const provider = makeProvider();
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') return;
    expect(result.error.message).toMatch(/requires a model/);
  });

  it('concatenates multiple system messages into a single Converse system block', async () => {
    const provider = makeProvider();
    await provider.chat({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const command = mockSend.mock.calls[0]![0] as { input: { system?: Array<{ text: string }>; messages: unknown[] } };
    expect(command.input.system).toEqual([{ text: 'You are helpful.\n\nBe concise.' }]);
    expect(command.input.messages).toHaveLength(1);
  });

  it('maps base64 image content to Converse image bytes format', async () => {
    const provider = makeProvider();
    await provider.chat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
          ],
        },
      ],
    });

    const command = mockSend.mock.calls[0]![0] as {
      input: { messages: Array<{ content: Array<{ text?: string; image?: { format: string; source: { bytes: Uint8Array } } }> }> };
    };
    const userContent = command.input.messages[0]!.content;
    expect(userContent[0]).toEqual({ text: 'What is in this image?' });
    expect(userContent[1]!.image?.format).toBe('png');
    expect(Buffer.from(userContent[1]!.image!.source.bytes).toString('base64')).toBe('iVBORw0KGgoAAAANSUhEUg==');
  });

  describe('malformed conversation history normalization', () => {
    // Reproduces the real production failure: a mid-history 'system'-role
    // conversation-summary turn (written by WorkingMemory's summarization pass)
    // gets stripped out by the system-message extraction above, leaving
    // 'assistant' as the new first element — which Bedrock Converse rejects
    // with "A conversation must start with a user message."
    it('drops a leading assistant message left behind after system-message extraction', async () => {
      const provider = makeProvider();
      await provider.chat({
        model: MODEL,
        messages: [
          { role: 'system', content: '[Conversation summary] Anshula and the assistant discussed onboarding.' },
          { role: 'assistant', content: 'To share something with me over email, you can send it to...' },
          { role: 'user', content: 'What do you mean by "the prompt"?' },
        ],
      });

      const command = mockSend.mock.calls[0]![0] as { input: { messages: Array<{ role: string }> } };
      expect(command.input.messages[0]!.role).toBe('user');
      expect(command.input.messages.map((m) => m.role)).toEqual(['user']);
    });

    // Reproduces the other real production cause: a failed LLM call persists
    // the user's turn before the call but never gets a paired assistant turn
    // written back, so the next message stacks a second 'user' turn on top.
    it('merges consecutive same-role messages instead of sending them separately', async () => {
      const provider = makeProvider();
      await provider.chat({
        model: MODEL,
        messages: [
          { role: 'user', content: "I'm confused" },
          { role: 'user', content: 'Hello?' },
          { role: 'assistant', content: 'Hello! How can I help?' },
          { role: 'user', content: 'Where do I find my contact details?' },
        ],
      });

      const command = mockSend.mock.calls[0]![0] as { input: { messages: Array<{ role: string; content: Array<{ text?: string }> }> } };
      expect(command.input.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(command.input.messages[0]!.content.map((c) => c.text)).toEqual(["I'm confused", 'Hello?']);
    });

    it('leaves a well-formed alternating sequence untouched', async () => {
      const provider = makeProvider();
      await provider.chat({
        model: MODEL,
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
          { role: 'user', content: 'How are you?' },
        ],
      });

      const command = mockSend.mock.calls[0]![0] as { input: { messages: Array<{ role: string; content: Array<{ text?: string }> }> } };
      expect(command.input.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(command.input.messages.map((m) => m.content[0]!.text)).toEqual(['Hi', 'Hello!', 'How are you?']);
    });
  });

  it('drops url-sourced images with a warning (Converse only accepts raw bytes)', async () => {
    const logger = createSilentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const provider = makeProvider(logger);

    await provider.chat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } }],
        },
      ],
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/URL source is not supported/));
    const command = mockSend.mock.calls[0]![0] as { input: { messages: Array<{ content: unknown[] }> } };
    expect(command.input.messages[0]!.content).toHaveLength(0);
  });

  it('logs warn when stopReason is "max_tokens" (response truncated)', async () => {
    mockSend.mockResolvedValue({
      ...makeTextResponse(),
      stopReason: 'max_tokens',
      output: { message: { role: 'assistant', content: [{ text: 'This response was cut off mid-' }] } },
    });

    const logger = createSilentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const provider = makeProvider(logger);
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Write a long essay' }],
      model: MODEL,
    });

    expect(result.type).toBe('text');
    if (result.type !== 'text') return;
    expect(result.content).toBe('This response was cut off mid-');

    expect(warnSpy).toHaveBeenCalledOnce();
    const [bindings, message] = warnSpy.mock.calls[0]! as [Record<string, unknown>, string];
    expect(bindings).toMatchObject({ model: MODEL, stopReason: 'max_tokens' });
    expect(message).toMatch(/truncated/);
  });

  it('logs error when the model narrates an intended tool call instead of invoking it', async () => {
    // Reproduces the real failure captured against production traffic: a large
    // system prompt + many tools caused mistral-large-2402 to describe the call
    // as prose/JSON instead of emitting a Converse toolUse block.
    mockSend.mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [{
            text: 'To list the scheduled jobs, I will use the "scheduler_list" function.\n\n'
              + '```json\n{\n  "name": "scheduler_list",\n  "arguments": {}\n}\n```\n'
              + 'This will return a list of all scheduled jobs along with their cron schedules.',
          }],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 11875, outputTokens: 102, totalTokens: 11977 },
      $metadata: { requestId: 'req-narrated-999' },
    });

    const logger = createSilentLogger();
    const errorSpy = vi.spyOn(logger, 'error');
    const provider = makeProvider(logger);
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'What scheduled jobs do you have running?' }],
      model: MODEL,
      tools: [{ name: 'scheduler_list', description: 'List scheduled jobs', input_schema: { type: 'object', properties: {} } }],
    });

    // The response itself is still returned as normal text — this is a detection/
    // observability improvement, not a behavior change to the response shape.
    expect(result.type).toBe('text');

    const call = errorSpy.mock.calls.find(([, msg]) => typeof msg === 'string' && msg.includes('described a tool call'));
    expect(call).toBeDefined();
    const [bindings] = call! as [Record<string, unknown>, string];
    expect(bindings).toMatchObject({ model: MODEL, uncalledTool: 'scheduler_list' });
  });

  it('does not flag a text response that merely mentions a tool name in passing', async () => {
    mockSend.mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'I have a scheduler_list tool available, but nothing is scheduled right now that I need to check.' }],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      $metadata: { requestId: 'req-benign-1' },
    });

    const logger = createSilentLogger();
    const errorSpy = vi.spyOn(logger, 'error');
    const provider = makeProvider(logger);
    await provider.chat({
      messages: [{ role: 'user', content: 'Anything scheduled?' }],
      model: MODEL,
      tools: [{ name: 'scheduler_list', description: 'List scheduled jobs', input_schema: { type: 'object', properties: {} } }],
    });

    const call = errorSpy.mock.calls.find(([, msg]) => typeof msg === 'string' && msg.includes('described a tool call'));
    expect(call).toBeUndefined();
  });

  it('does not log warn for normal end_turn stopReason', async () => {
    const logger = createSilentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const provider = makeProvider(logger);

    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: MODEL,
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to options.model when model param is not provided', async () => {
    const provider = makeProvider();
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      options: { model: MODEL },
    });

    const command = mockSend.mock.calls[0]![0] as { input: { modelId: string } };
    expect(command.input.modelId).toBe(MODEL);
  });

  it('uses explicit model param over options.model', async () => {
    const provider = makeProvider();
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: MODEL,
      options: { model: 'mistral.mixtral-8x7b-instruct-v0:1' },
    });

    const command = mockSend.mock.calls[0]![0] as { input: { modelId: string } };
    expect(command.input.modelId).toBe(MODEL);
  });

  it('passes an AbortSignal to client.send() for timeout enforcement', async () => {
    const provider = makeProvider();
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: MODEL,
    });

    const sendOpts = mockSend.mock.calls[0]![1] as { abortSignal?: AbortSignal };
    expect(sendOpts.abortSignal).toBeInstanceOf(AbortSignal);
    expect(sendOpts.abortSignal?.aborted).toBe(false);
  });
});
