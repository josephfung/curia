// src/channels/signal/signal-rpc-client-calls.test.ts
//
// Tests for the voice-call RPC methods and callEvent emission added to
// SignalRpcClient (curia#1672). Exercises the client against a real
// net.Server on a temp unix socket so the full write/parse/reconnect path
// is covered, not just the call-types.ts codec in isolation.

import { mkdtempSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalRpcClient, decodeSignalAttachmentResult } from './signal-rpc-client.js';
import type { SignalCallEvent } from './call-types.js';
import { createSilentLogger } from '../../logger.js';

const ACCOUNT = '+12264448150';

function listen(socketPath: string, onLine: (line: string, sock: net.Socket) => void): Promise<net.Server> {
  return new Promise(resolve => {
    const server = net.createServer(sock => {
      let buf = '';
      sock.on('data', chunk => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) onLine(l, sock);
      });
    });
    server.listen(socketPath, () => resolve(server));
  });
}

describe('SignalRpcClient call support', () => {
  let dir: string;
  let socketPath: string;
  let server: net.Server;
  let client: SignalRpcClient;
  const received: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sigrpc-'));
    socketPath = join(dir, 'socket');
    received.length = 0;
  });

  afterEach(async () => {
    await client.disconnect();
    server.close();
  });

  it('sends subscribeCallEvents on connect when enabled, and resubscribes after reconnect', async () => {
    const sockets: net.Socket[] = [];
    server = await listen(socketPath, (line, sock) => {
      received.push(line);
      if (!sockets.includes(sock)) sockets.push(sock);
      const req = JSON.parse(line) as { id: string; method: string };
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 7 }) + '\n');
    });
    client = new SignalRpcClient({ socketPath, accountNumber: ACCOUNT, logger: createSilentLogger() });
    client.setCallEventsSubscription(true);
    client.connect();
    await new Promise<void>(r => client.once('connected', () => r()));
    await vi.waitFor(() => expect(received.some(l => l.includes('subscribeCallEvents'))).toBe(true));

    // Drop the connection; client reconnects (1s backoff) and must resubscribe.
    received.length = 0;
    sockets[0]!.destroy();
    await vi.waitFor(
      () => expect(received.some(l => l.includes('subscribeCallEvents'))).toBe(true),
      { timeout: 5_000 },
    );
  });

  it('emits callEvent with full-precision bigint callId', async () => {
    server = await listen(socketPath, (line, sock) => {
      const req = JSON.parse(line) as { id?: string };
      if (req.id) sock.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 1 }) + '\n');
      // After the subscribe request, push a callEvent notification.
      sock.write(
        '{"jsonrpc":"2.0","method":"callEvent","params":{"subscription":1,"result":'
        + '{"callId":-7828393543136742976,"state":"RINGING_INCOMING","number":"+15196161377",'
        + '"isOutgoing":false,"inputDeviceName":"signal_input_x","outputDeviceName":"signal_output_x"}}}\n',
      );
    });
    client = new SignalRpcClient({ socketPath, accountNumber: ACCOUNT, logger: createSilentLogger() });
    client.setCallEventsSubscription(true);
    client.connect();
    const ev = await new Promise<SignalCallEvent>(r => client.once('callEvent', r));
    expect(ev.callId).toBe(-7828393543136742976n);
    expect(ev.state).toBe('RINGING_INCOMING');
    expect(ev.number).toBe('+15196161377');
  });

  it('acceptCall writes callId as a bare number literal with full precision', async () => {
    server = await listen(socketPath, (line, sock) => {
      received.push(line);
      const req = JSON.parse(line) as { id: string };
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\n');
    });
    client = new SignalRpcClient({ socketPath, accountNumber: ACCOUNT, logger: createSilentLogger() });
    client.connect();
    await new Promise<void>(r => client.once('connected', () => r()));
    await client.acceptCall(-7828393543136742976n);
    const line = received.find(l => l.includes('acceptCall'))!;
    expect(line).toContain('"callId":-7828393543136742976');
    expect(line).toContain(`"account":"${ACCOUNT}"`);
  });

  it('getAttachment sends id + recipient and decodes { data } base64', async () => {
    server = await listen(socketPath, (line, sock) => {
      received.push(line);
      const req = JSON.parse(line) as { id: string };
      sock.write(
        JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { data: Buffer.from('ogg-bytes').toString('base64') } }) + '\n',
      );
    });
    client = new SignalRpcClient({ socketPath, accountNumber: ACCOUNT, logger: createSilentLogger() });
    client.connect();
    await new Promise<void>(r => client.once('connected', () => r()));
    const bytes = await client.getAttachment({ id: 'att-1', recipient: '+15551212' });
    expect(Buffer.from(bytes).toString('utf8')).toBe('ogg-bytes');
    const line = received.find(l => l.includes('getAttachment'))!;
    expect(line).toContain('"id":"att-1"');
    expect(line).toContain('"recipient":"+15551212"');
    expect(line).toContain(`"account":"${ACCOUNT}"`);
  });
});

describe('decodeSignalAttachmentResult', () => {
  it('decodes { data } and raw base64 strings', () => {
    const payload = Buffer.from('hello').toString('base64');
    expect(Buffer.from(decodeSignalAttachmentResult({ data: payload })).toString()).toBe('hello');
    expect(Buffer.from(decodeSignalAttachmentResult(payload)).toString()).toBe('hello');
  });

  it('throws when data is missing or empty', () => {
    expect(() => decodeSignalAttachmentResult({})).toThrow('missing attachment data');
    expect(() => decodeSignalAttachmentResult({ data: '' })).toThrow('missing attachment data');
  });
});
