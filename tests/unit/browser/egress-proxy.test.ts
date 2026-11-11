// Tests for the browser container's egress proxy (#2521): which addresses it refuses, and
// that it forwards to the address it checked, directly or through an upstream proxy.

import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import {
  createEgressProxy,
  isPrivateAddress,
  openTunnel,
  parseUpstream,
  vetHost,
  type HostLookup,
  type Upstream,
} from '../../../src/browser/egress-proxy.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fd00::1', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe', '[::1]',
    'not-an-address', '',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '93.184.215.14', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('vetHost', () => {
  const lookup: HostLookup = async (hostname) => {
    if (hostname === 'public.test') return [{ address: '93.184.215.14' }];
    if (hostname === 'rebind.test') return [{ address: '93.184.215.14' }, { address: '10.0.0.1' }];
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };

  it('returns every address of a public host', async () => {
    expect(await vetHost('public.test', lookup)).toEqual({ ok: true, addresses: ['93.184.215.14'] });
  });

  it('refuses a host with any private address', async () => {
    expect(await vetHost('rebind.test', lookup)).toMatchObject({ ok: false });
  });

  it('refuses a host that does not resolve, naming the error code', async () => {
    const vetted = await vetHost('missing.test', lookup);
    expect(vetted).toMatchObject({ ok: false });
    if (!vetted.ok) expect(vetted.reason).toContain('ENOTFOUND');
  });

  it('checks IP literals without resolving them', async () => {
    const never: HostLookup = async () => { throw new Error('should not be asked'); };
    expect(await vetHost('[::1]', never)).toMatchObject({ ok: false });
    expect(await vetHost('8.8.8.8', never)).toEqual({ ok: true, addresses: ['8.8.8.8'] });
  });
});

describe('parseUpstream', () => {
  it('reads http, https and socks5 proxies, with default ports', () => {
    expect(parseUpstream('http://proxy:8888')).toEqual({ protocol: 'http', host: 'proxy', port: 8888 });
    expect(parseUpstream('https://proxy.example/')).toEqual({ protocol: 'https', host: 'proxy.example', port: 443 });
    expect(parseUpstream('socks5://10.0.0.2')).toEqual({ protocol: 'socks5', host: '10.0.0.2', port: 1080 });
  });

  it('means a direct connection when unset', () => {
    expect(parseUpstream(undefined)).toBeNull();
    expect(parseUpstream('')).toBeNull();
  });

  it('refuses credentials and other shapes rather than egress directly', () => {
    expect(() => parseUpstream('http://user:pass@proxy:8888')).toThrow(/BROWSER_PROXY/);
    expect(() => parseUpstream('ftp://proxy:21')).toThrow(/BROWSER_PROXY/);
  });

  it.each(['http://proxy:70000', 'http://proxy:0', 'socks5://proxy:65536', 'http://proxy:99999999999'])(
    'refuses the out-of-range port in %s',
    (raw) => {
      expect(() => parseUpstream(raw)).toThrow(/port/);
    },
  );

  it('accepts the ends of the port range', () => {
    expect(parseUpstream('http://proxy:1')?.port).toBe(1);
    expect(parseUpstream('http://proxy:65535')?.port).toBe(65535);
  });
});

describe('openTunnel negotiation', () => {
  it.each(['http', 'socks5'] as const)('gives up on a %s upstream that never answers', async (protocol) => {
    const silent = net.createServer(() => { /* accept and say nothing */ });
    const port = await listen(silent);
    const accepted = once(silent, 'connection');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const opening = openTunnel('93.184.215.14', 443, { protocol, host: '127.0.0.1', port });
      const outcome = expect(opening).rejects.toThrow(/did not answer/);
      await accepted;
      // The negotiation deadline starts once the upstream is connected.
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(16_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the upstream socket when the client goes away mid-negotiation', async () => {
    const accepted: net.Socket[] = [];
    // resume() so the socket reads the client's FIN and closes.
    const silent = net.createServer((s) => { accepted.push(s); s.resume(); });
    const port = await listen(silent);
    const gone = new AbortController();
    const opening = openTunnel('93.184.215.14', 443, { protocol: 'http', host: '127.0.0.1', port }, gone.signal);
    const outcome = expect(opening).rejects.toThrow(/went away/);
    while (accepted.length === 0) await new Promise((r) => setTimeout(r, 5));
    const closed = once(accepted[0]!, 'close');
    gone.abort();
    await outcome;
    await closed;
  });
});

// -- Through the proxy ----------------------------------------------------------------

const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
    if ('closeAllConnections' in server) (server as http.Server).closeAllConnections();
  }
});

async function listen<T extends net.Server>(server: T): Promise<number> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

/** Names the tests use: `site.test` stands for a public site served on loopback here. */
const testLookup: HostLookup = async (hostname) => {
  if (hostname === 'site.test') return [{ address: '127.0.0.1' }];
  if (hostname === 'internal.test') return [{ address: '10.0.0.9' }];
  throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
};
/** Everything private except loopback, which stands in for the public internet. */
const allowLoopback = (address: string): boolean => address !== '127.0.0.1' && isPrivateAddress(address);

async function startProxy(upstream: Upstream | null, logs: string[] = []): Promise<number> {
  return listen(createEgressProxy({ upstream, lookup: testLookup, isPrivate: allowLoopback, log: (l) => logs.push(l) }));
}

async function startSite(): Promise<number> {
  return listen(http.createServer((req, res) => res.end(`site saw ${req.method} ${req.url} host=${req.headers.host}`)));
}

/** A plain HTTP request sent to the proxy in absolute form, as Chrome sends one. */
function proxiedGet(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: new URL(url).host } });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** CONNECT through the proxy; resolves the status line and, on 200, the open socket. */
function connectVia(proxyPort: number, target: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on('error', reject);
    req.end();
  });
}

async function getOver(socket: net.Socket, host: string): Promise<string> {
  socket.write(`GET /tunnelled HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  let data = '';
  socket.setEncoding('utf8');
  socket.on('data', (c: string) => { data += c; });
  await once(socket, 'end');
  return data;
}

describe('createEgressProxy', () => {
  it('forwards a plain HTTP request to a public host', async () => {
    const sitePort = await startSite();
    const proxyPort = await startProxy(null);
    const res = await proxiedGet(proxyPort, `http://site.test:${sitePort}/page?q=1`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(`site saw GET /page?q=1 host=site.test:${sitePort}`);
  });

  it('tunnels CONNECT to a public host', async () => {
    const sitePort = await startSite();
    const proxyPort = await startProxy(null);
    const { status, socket } = await connectVia(proxyPort, `site.test:${sitePort}`);
    expect(status).toBe(200);
    expect(await getOver(socket, 'site.test')).toContain('site saw GET /tunnelled');
  });

  it('refuses CONNECT and plain HTTP to a name that resolves privately, and logs it', async () => {
    const logs: string[] = [];
    const proxyPort = await startProxy(null, logs);
    expect((await connectVia(proxyPort, 'internal.test:443')).status).toBe(403);
    expect((await proxiedGet(proxyPort, 'http://internal.test/')).status).toBe(403);
    expect(logs.join('\n')).toMatch(/refused CONNECT to internal\.test:443: .*10\.0\.0\.9/);
  });

  it('refuses private literals, including ones the URL parser rewrites', async () => {
    const proxyPort = await startProxy(null);
    expect((await connectVia(proxyPort, '169.254.169.254:80')).status).toBe(403);
    expect((await connectVia(proxyPort, '[::ffff:a00:1]:80')).status).toBe(403);
    expect((await proxiedGet(proxyPort, 'http://0x7f000002/')).status).toBe(403);
  });

  it('refuses a name that does not resolve', async () => {
    const proxyPort = await startProxy(null);
    expect((await connectVia(proxyPort, 'missing.test:443')).status).toBe(403);
  });

  it('hands an HTTP upstream the vetted address, never the hostname', async () => {
    const sitePort = await startSite();
    const targets: string[] = [];
    const upstream = http.createServer();
    upstream.on('connect', (req: http.IncomingMessage, client: net.Socket) => {
      targets.push(req.url ?? '');
      const [host, port] = (req.url ?? '').split(':');
      const out = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(out);
        out.pipe(client);
      });
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await startProxy({ protocol: 'http', host: '127.0.0.1', port: upstreamPort });

    const { status, socket } = await connectVia(proxyPort, `site.test:${sitePort}`);
    expect(status).toBe(200);
    expect(await getOver(socket, 'site.test')).toContain('site saw GET /tunnelled');
    // Plain HTTP goes through the upstream as a tunnel too.
    expect((await proxiedGet(proxyPort, `http://site.test:${sitePort}/plain`)).body).toContain('/plain');
    expect(targets).toEqual([`127.0.0.1:${sitePort}`, `127.0.0.1:${sitePort}`]);
  });

  it('hands a SOCKS5 upstream the vetted address', async () => {
    const sitePort = await startSite();
    const requested: string[] = [];
    const socks = net.createServer((client) => {
      client.once('data', () => {
        client.write(Buffer.from([5, 0]));
        client.once('data', (req: Buffer) => {
          const host = [...req.subarray(4, 8)].join('.');
          const port = req.readUInt16BE(8);
          requested.push(`${host}:${port}`);
          const out = net.connect(port, host, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.pipe(out);
            out.pipe(client);
          });
        });
      });
    });
    const socksPort = await listen(socks);
    const proxyPort = await startProxy({ protocol: 'socks5', host: '127.0.0.1', port: socksPort });

    const { status, socket } = await connectVia(proxyPort, `site.test:${sitePort}`);
    expect(status).toBe(200);
    expect(await getOver(socket, 'site.test')).toContain('site saw GET /tunnelled');
    expect(requested).toEqual([`127.0.0.1:${sitePort}`]);
  });

  it.each(['CONNECT', 'plain HTTP'])('closes the upstream socket when the client hangs up mid-setup (%s)', async (kind) => {
    const accepted: net.Socket[] = [];
    const sitePort = await listen(net.createServer((s) => { accepted.push(s); s.on('error', () => undefined); }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const slowLookup: HostLookup = async (hostname) => { await gate; return testLookup(hostname); };
    const proxyPort = await listen(createEgressProxy({ upstream: null, lookup: slowLookup, isPrivate: allowLoopback, log: () => undefined }));

    const client = net.connect(proxyPort, '127.0.0.1');
    client.on('error', () => undefined);
    await once(client, 'connect');
    client.write(kind === 'CONNECT'
      ? `CONNECT site.test:${sitePort} HTTP/1.1\r\nHost: site.test:${sitePort}\r\n\r\n`
      : `GET http://site.test:${sitePort}/ HTTP/1.1\r\nHost: site.test:${sitePort}\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 50));
    client.destroy();
    await once(client, 'close');
    release();

    // The proxy may open the upstream connection before it notices; it must then close it.
    await new Promise((r) => setTimeout(r, 200));
    for (const s of accepted) expect(s.destroyed || s.readableEnded || s.closed).toBe(true);
  });

  it('answers 502 when the upstream refuses', async () => {
    const upstream = http.createServer();
    upstream.on('connect', (_req: http.IncomingMessage, client: net.Socket) => {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await startProxy({ protocol: 'http', host: '127.0.0.1', port: upstreamPort });
    expect((await connectVia(proxyPort, 'site.test:443')).status).toBe(502);
  });
});
