import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackClient, SlackFileDownloadError } from './slack-client.js';
import { createSilentLogger } from '../../logger.js';
import { MAX_VOICE_NOTE_BYTES } from '../inbound-voice-note.js';

describe('SlackClient.downloadFile', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    let sent = false;
    return new ReadableStream({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(bytes);
      },
    });
  }

  function mockOkFetch(audio: Uint8Array, contentLength?: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? contentLength ?? null : null) },
      body: bytesStream(audio),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('sends the bot token as a Bearer Authorization header with a timeout', async () => {
    const audio = new Uint8Array([1, 2, 9]);
    const fetchMock = mockOkFetch(audio);

    const client = new SlackClient({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      logger: createSilentLogger(),
    });
    const url = 'https://files.slack.com/files-pri/T/F/download';
    const bytes = await client.downloadFile(url);
    expect(bytes).toEqual(audio);
    expect(fetchMock).toHaveBeenCalledWith(url, {
      headers: { Authorization: 'Bearer xoxb-test-token' },
      signal: expect.any(AbortSignal),
    });
    await client.disconnect();
  });

  it('refuses to send the bot token to a non-Slack host', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new SlackClient({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      logger: createSilentLogger(),
    });
    await expect(client.downloadFile('https://evil.example/file'))
      .rejects.toThrow('URL host is not files.slack.com');
    expect(fetchMock).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it('throws SlackFileDownloadError on a non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      body: { cancel: async () => undefined },
    }) as unknown as typeof fetch;

    const client = new SlackClient({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      logger: createSilentLogger(),
    });
    await expect(client.downloadFile('https://files.slack.com/x'))
      .rejects.toBeInstanceOf(SlackFileDownloadError);
    await client.disconnect();
  });

  it('refuses a content-length over the voice-note cap', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => String(MAX_VOICE_NOTE_BYTES + 1) },
      body: { cancel: async () => undefined },
    }) as unknown as typeof fetch;

    const client = new SlackClient({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      logger: createSilentLogger(),
    });
    await expect(client.downloadFile('https://files.slack.com/x'))
      .rejects.toThrow('content-length exceeds voice-note cap');
    await client.disconnect();
  });

  it('aborts a chunked body that exceeds the voice-note cap', async () => {
    const chunk = new Uint8Array(64 * 1024);
    let cancelled = false;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
    }) as unknown as typeof fetch;

    const client = new SlackClient({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      logger: createSilentLogger(),
    });
    await expect(client.downloadFile('https://files.slack.com/x'))
      .rejects.toThrow('body exceeds voice-note cap');
    expect(cancelled).toBe(true);
    await client.disconnect();
  });
});
