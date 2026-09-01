import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackClient } from './slack-client.js';
import { createSilentLogger } from '../../logger.js';

describe('SlackClient.downloadFile', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends the bot token as a Bearer Authorization header', async () => {
    const audio = new Uint8Array([1, 2, 9]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audio.buffer,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
    });
    await client.disconnect();
  });

  it('throws on a non-OK response', async () => {
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
    await expect(client.downloadFile('https://files.slack.com/x')).rejects.toThrow('HTTP 401');
    await client.disconnect();
  });
});
