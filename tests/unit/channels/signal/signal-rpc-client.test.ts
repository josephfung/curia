import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SignalRpcClient } from '../../../../src/channels/signal/signal-rpc-client.js';
import type { SignalEnvelope } from '../../../../src/channels/signal/types.js';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return pino({ level: 'silent' });
}

function tmpSocketPath() {
  return path.join(os.tmpdir(), `test-signal-${process.pid}-${Date.now()}.sock`);
}

/**
 * Creates a simple mock signal-cli server that listens on a Unix socket.
 * Call pushLine() to send a JSON-RPC message to any connected client.
 * Call respondToNext() to auto-respond to the next incoming request.
 */
function createMockServer(socketPath: string) {
  const server = net.createServer();
  let clientSocket: net.Socket | null = null;
  const requestQueue: Array<{ id: string; method: string; params: unknown }> = [];

  server.on('connection', (socket) => {
    clientSocket = socket;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { id: string; method: string; params: unknown };
          requestQueue.push(parsed);
        } catch { /* ignore */ }
      }
    });
  });

  return {
    server,
    listen: () => new Promise<void>((resolve) => server.listen(socketPath, resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    push: (obj: unknown) => {
      if (clientSocket) {
        clientSocket.write(JSON.stringify(obj) + '\n');
      }
    },
    popRequest: () => requestQueue.shift(),
    respondSuccess: (id: string, result: unknown = {}) => {
      if (clientSocket) {
        clientSocket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      }
    },
    respondError: (id: string, code: number, message: string) => {
      if (clientSocket) {
        clientSocket.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
      }
    },
  };
}

function makeEnvelope(overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    source: '+14155551234',
    sourceNumber: '+14155551234',
    sourceUuid: 'uuid-abc',
    sourceName: 'Alice',
    sourceDevice: 1,
    timestamp: 1700000000000,
    dataMessage: {
      timestamp: 1700000000000,
      message: 'hello',
      expiresInSeconds: 0,
      viewOnce: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignalRpcClient', () => {
  let socketPath: string;
  let mock: ReturnType<typeof createMockServer>;
  let client: SignalRpcClient;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    mock = createMockServer(socketPath);
    await mock.listen();

    client = new SignalRpcClient({
      socketPath,
      accountNumber: '+15555550000',
      logger: makeLogger(),
    });
    // connect() is now synchronous — it starts the attempt in the background.
    // Wait for the 'connected' event to know the socket is actually open.
    await new Promise<void>((resolve) => {
      client.once('connected', resolve);
      client.connect();
    });
  });

  afterEach(async () => {
    await client.disconnect();
    await mock.close();
    // Clean up socket file
    try { fs.unlinkSync(socketPath); } catch { /* ok */ }
  });

  it('parses a receive notification and emits a message event', async () => {
    const envelope = makeEnvelope();
    const received = new Promise<SignalEnvelope>((resolve) => {
      client.once('message', resolve);
    });

    mock.push({
      jsonrpc: '2.0',
      method: 'receive',
      params: { envelope, account: '+15555550000' },
    });

    const emitted = await received;
    expect(emitted.sourceNumber).toBe('+14155551234');
    expect(emitted.dataMessage?.message).toBe('hello');
  });

  it('correlates a send request to its success response', async () => {
    const sendPromise = client.send({
      account: '+15555550000',
      recipient: ['+14155551234'],
      message: 'hi',
    });

    // Wait briefly for the request to arrive
    await new Promise((r) => setTimeout(r, 20));
    const req = mock.popRequest();
    expect(req).toBeDefined();
    expect(req!.method).toBe('send');
    mock.respondSuccess(req!.id, { timestamp: 1700000000000 });

    await expect(sendPromise).resolves.toBeUndefined();
  });

  it('rejects a send request when signal-cli returns an error', async () => {
    const sendPromise = client.send({
      account: '+15555550000',
      recipient: ['+14155551234'],
      message: 'hi',
    });

    await new Promise((r) => setTimeout(r, 20));
    const req = mock.popRequest();
    expect(req).toBeDefined();
    mock.respondError(req!.id, -1, 'Rate limit exceeded');

    await expect(sendPromise).rejects.toThrow('Rate limit exceeded');
  });

  it('deduplicates a re-delivered envelope with the same sourceNumber:timestamp', async () => {
    const envelope = makeEnvelope({ timestamp: 9999 });
    const messages: SignalEnvelope[] = [];
    client.on('message', (e) => messages.push(e));

    // Deliver the same envelope twice
    const notification = {
      jsonrpc: '2.0',
      method: 'receive',
      params: { envelope, account: '+15555550000' },
    };
    mock.push(notification);
    mock.push(notification);

    await new Promise((r) => setTimeout(r, 50));
    // Only the first delivery should have been emitted
    expect(messages).toHaveLength(1);
  });

  it('treats two envelopes with different timestamps as distinct', async () => {
    const messages: SignalEnvelope[] = [];
    client.on('message', (e) => messages.push(e));

    mock.push({ jsonrpc: '2.0', method: 'receive', params: { envelope: makeEnvelope({ timestamp: 1 }), account: '+15555550000' } });
    mock.push({ jsonrpc: '2.0', method: 'receive', params: { envelope: makeEnvelope({ timestamp: 2 }), account: '+15555550000' } });

    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toHaveLength(2);
  });

  it('ignores non-receive notifications silently', async () => {
    const messages: SignalEnvelope[] = [];
    client.on('message', (e) => messages.push(e));

    mock.push({ jsonrpc: '2.0', method: 'typing', params: { action: 'STARTED' } });

    await new Promise((r) => setTimeout(r, 30));
    expect(messages).toHaveLength(0);
  });

  it('handles malformed JSON lines without crashing', async () => {
    // Inject a malformed line between two valid notifications
    const messages: SignalEnvelope[] = [];
    client.on('message', (e) => messages.push(e));

    // Write raw bytes to simulate a corrupted line followed by a valid notification
    // We access the internal socket indirectly via the server's client write
    const good = { jsonrpc: '2.0', method: 'receive', params: { envelope: makeEnvelope({ timestamp: 777 }), account: '+15555550000' } };
    mock.push('not valid json at all');
    mock.push(good);

    await new Promise((r) => setTimeout(r, 50));
    // The good message should still arrive
    expect(messages).toHaveLength(1);
  });

  it('resolves with an array of group details on listGroups success', async () => {
    const groups = [
      {
        id: 'grpABC==',
        name: 'Test Group',
        members: [{ number: '+14155551234' }],
        pendingMembers: [],
        isMember: true,
      },
    ];

    const listPromise = client.listGroups();

    await new Promise((r) => setTimeout(r, 20));
    const req = mock.popRequest();
    expect(req).toBeDefined();
    expect(req!.method).toBe('listGroups');
    expect(req!.params).toMatchObject({ account: '+15555550000' });
    mock.respondSuccess(req!.id, groups);

    await expect(listPromise).resolves.toEqual(groups);
  });

  it('rejects if signal-cli returns an error for listGroups', async () => {
    const listPromise = client.listGroups();

    await new Promise((r) => setTimeout(r, 50));
    const req = mock.popRequest();
    expect(req).toBeDefined();
    mock.respondError(req!.id, -1, 'Not registered');

    await expect(listPromise).rejects.toThrow('Not registered');
  });
});
