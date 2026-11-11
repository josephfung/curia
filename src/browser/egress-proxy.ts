// egress-proxy.ts — the forward proxy Chrome in the browser container sends every request
// through (#2521). It resolves each destination once, refuses any whose addresses include
// a private, loopback, link-local or otherwise non-public one, and connects to the address
// it checked, so DNS rebinding between check and connect does not apply. Page JavaScript
// (fetch, form posts, subresources) goes through it as well as navigation, which the
// navigate guard alone cannot cover.
//
// The browser image runs this file directly with Node's type stripping, so it must stay
// self-contained: node: built-ins only, no relative imports, erasable TypeScript only.
// The web-browser skill imports isPrivateAddress from here, so both use one definition.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { lookup as dnsLookup } from 'node:dns/promises';

// -- Address classification -----------------------------------------------------------

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"; 0.0.0.0 reaches the local host
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, also used by Tailscale
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including the cloud metadata address
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
];

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible forms
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

const blockList = new net.BlockList();
for (const [prefix, bits] of BLOCKED_V4) blockList.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of BLOCKED_V6) blockList.addSubnet(prefix, bits, 'ipv6');

/** The 16 bytes of an IPv6 address, or null if it does not parse. */
function ipv6Bytes(address: string): number[] | null {
  let a = address.toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (dotted) {
    const o = dotted[2]!.split('.').map(Number);
    a = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes;
}

/**
 * True for an IP address Chrome must never reach: loopback, RFC 1918, link-local,
 * carrier-grade NAT, unique-local, multicast, reserved, and the IPv4 address embedded in
 * an IPv4-mapped (::ffff:0:0/96) or NAT64 (64:ff9b::/96) IPv6 address. Anything that is
 * not an IP address is refused too: callers pass resolved addresses, so fail closed.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[(.*)\]$/, '$1');
  const family = net.isIP(bare);
  if (family === 4) return blockList.check(bare, 'ipv4');
  if (family !== 6) return true;
  const bytes = ipv6Bytes(bare);
  if (!bytes) return true;
  const prefix = bytes.slice(0, 12);
  const mapped = prefix.slice(0, 10).every((b) => b === 0) && prefix[10] === 0xff && prefix[11] === 0xff;
  const nat64 = prefix[0] === 0x00 && prefix[1] === 0x64 && prefix[2] === 0xff && prefix[3] === 0x9b
    && prefix.slice(4).every((b) => b === 0);
  if (mapped || nat64) return blockList.check(bytes.slice(12).join('.'), 'ipv4');
  return blockList.check(bare.replace(/%.*$/, ''), 'ipv6');
}

// -- Resolution -----------------------------------------------------------------------

export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const LOOKUP_TIMEOUT_MS = 5_000;

/** getaddrinfo has no time limit of its own: a timeout rejects, which vetHost treats as did-not-resolve. */
export const defaultLookup: HostLookup = (hostname) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`lookup of ${hostname} timed out`), { code: 'ETIMEOUT' })),
      LOOKUP_TIMEOUT_MS,
    );
  });
  return Promise.race([dnsLookup(hostname, { all: true }), timeout]).finally(() => clearTimeout(timer));
};

/** The outcome of vetting a destination host. */
export type Vetted =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: string };

/**
 * Resolve `host` once and vet every address it returns. One private address refuses the
 * whole host, so a name with mixed answers cannot be steered to the private one later.
 * A lookup failure refuses too: there is nothing to connect to that was checked.
 */
export async function vetHost(
  host: string,
  lookup: HostLookup = defaultLookup,
  isPrivate: (address: string) => boolean = isPrivateAddress,
): Promise<Vetted> {
  const bare = host.replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '');
  if (net.isIP(bare) !== 0) {
    return isPrivate(bare) ? { ok: false, reason: `${bare} is a private address` } : { ok: true, addresses: [bare] };
  }
  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(bare);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return { ok: false, reason: `${bare} did not resolve (${typeof code === 'string' ? code : 'lookup error'})` };
  }
  if (answers.length === 0) return { ok: false, reason: `${bare} did not resolve` };
  const blocked = answers.find((a) => isPrivate(a.address));
  if (blocked) return { ok: false, reason: `${bare} resolves to a private address (${blocked.address})` };
  return { ok: true, addresses: answers.map((a) => a.address) };
}

// -- Upstream proxy -------------------------------------------------------------------

export interface Upstream {
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
}

/**
 * Parse BROWSER_PROXY: http://host:port, https://host:port or socks5://host:port, with no
 * credentials. Empty means connect directly. Anything else throws, so a proxy that exists
 * to hide the server's IP is never silently skipped.
 */
export function parseUpstream(raw: string | undefined): Upstream | null {
  if (!raw) return null;
  const match = /^(https?|socks5):\/\/([A-Za-z0-9.-]+)(?::(\d+))?\/?$/.exec(raw);
  if (!match) throw new Error(`BROWSER_PROXY must look like http://host:port or socks5://host:port, got: ${raw}`);
  const protocol = match[1] as Upstream['protocol'];
  const defaultPort = protocol === 'https' ? 443 : protocol === 'socks5' ? 1080 : 80;
  const port = match[3] ? Number(match[3]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BROWSER_PROXY port must be 1 to 65535, got: ${raw}`);
  }
  return { protocol, host: match[2]!, port };
}

const CONNECT_TIMEOUT_MS = 15_000;
const NEGOTIATE_TIMEOUT_MS = 15_000;

function connectSocket(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error(`connecting to ${host}:${port} timed out`)));
    socket.once('connect', () => { socket.setTimeout(0); resolve(socket); });
    socket.once('error', reject);
  });
}

function connectTls(host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error(`connecting to ${host}:${port} timed out`)));
    socket.once('secureConnect', () => { socket.setTimeout(0); resolve(socket); });
    socket.once('error', reject);
  });
}

/** Read from `socket` until `done` says the reply is complete; push back any extra bytes. */
function readReply(socket: net.Socket, done: (buf: Buffer) => number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const length = done(buf);
      if (length < 0) return;
      cleanup();
      if (buf.length > length) socket.unshift(buf.subarray(length));
      resolve(buf.subarray(0, length));
    };
    const onEnd = (): void => { cleanup(); reject(new Error('the upstream proxy closed the connection')); };
    const onClose = (): void => { cleanup(); reject(new Error('the upstream proxy closed the connection')); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function httpConnectThrough(socket: net.Socket, address: string, port: number): Promise<void> {
  const target = net.isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const head = await readReply(socket, (buf) => {
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1 && buf.length > 16_384) return buf.length; // let the status check fail it
    return end === -1 ? -1 : end + 4;
  });
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'));
  if (!status || !status[1]!.startsWith('2')) {
    throw new Error(`the upstream proxy refused CONNECT (${status ? status[1] : 'no status line'})`);
  }
}

async function socks5ConnectThrough(socket: net.Socket, address: string, port: number): Promise<void> {
  socket.write(Buffer.from([5, 1, 0])); // version 5, one method: no authentication
  const greeting = await readReply(socket, (buf) => (buf.length >= 2 ? 2 : -1));
  if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error('the upstream SOCKS proxy wants authentication');
  const v6 = net.isIP(address) === 6;
  const addr = v6 ? Buffer.from(ipv6Bytes(address)!) : Buffer.from(address.split('.').map(Number));
  const portBytes = Buffer.from([port >> 8, port & 0xff]);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, v6 ? 4 : 1]), addr, portBytes]));
  const reply = await readReply(socket, (buf) => {
    if (buf.length < 5) return -1;
    const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : buf[3] === 3 ? 7 + buf[4]! : buf.length;
    return buf.length >= len ? len : -1;
  });
  if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`the upstream SOCKS proxy refused the connection (reply ${reply[1]})`);
}

/**
 * A connected socket to `address:port`, directly or through the upstream proxy. The
 * upstream gets the vetted address, never the hostname, so it cannot resolve the name
 * to somewhere else (a private address on its own network, say).
 */
export async function openTunnel(
  address: string,
  port: number,
  upstream: Upstream | null,
  /** Aborted when the client that asked for the tunnel has gone. */
  signal?: AbortSignal,
): Promise<net.Socket> {
  if (!upstream) return connectSocket(address, port);
  const socket = upstream.protocol === 'https'
    ? await connectTls(upstream.host, upstream.port)
    : await connectSocket(upstream.host, upstream.port);
  // An upstream that accepts the connection and then says nothing would hold readReply
  // forever; the deadline (or the client leaving) destroys the socket, which rejects the
  // pending read.
  const deadline = setTimeout(
    () => socket.destroy(new Error(`the upstream proxy did not answer within ${NEGOTIATE_TIMEOUT_MS} ms`)),
    NEGOTIATE_TIMEOUT_MS,
  );
  const onAbort = (): void => { socket.destroy(new Error('the client went away during negotiation')); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (upstream.protocol === 'socks5') await socks5ConnectThrough(socket, address, port);
    else await httpConnectThrough(socket, address, port);
  } catch (err) {
    socket.destroy();
    throw err;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
  }
  return socket;
}

/** Try each vetted address in turn: a host may list an IPv6 address this network cannot reach. */
async function openFirst(
  addresses: string[],
  port: number,
  upstream: Upstream | null,
  signal?: AbortSignal,
): Promise<net.Socket> {
  let lastError: unknown;
  for (const address of addresses) {
    if (signal?.aborted) break;
    try {
      return await openTunnel(address, port, upstream, signal);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no address could be reached');
}

// -- The proxy ------------------------------------------------------------------------

export interface EgressProxyOptions {
  upstream: Upstream | null;
  lookup?: HostLookup;
  /** Which addresses to refuse. Tests swap it to reach a server on loopback. */
  isPrivate?: (address: string) => boolean;
  /** One line per refusal or failure. Defaults to stderr. */
  log?: (line: string) => void;
}

/** Split CONNECT's authority-form target (host:port, [v6]:port) into its parts. */
function parseAuthority(target: string): { host: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:.%]+\]|[^:\s]+):(\d{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 ? { host: match[1]!, port } : null;
}

/** A tunnel or forwarded request with no traffic either way for this long is closed. */
const TUNNEL_IDLE_MS = 5 * 60_000;

const HOP_BY_HOP =new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** Create the proxy server; the caller listens on it (loopback only). */
export function createEgressProxy(options: EgressProxyOptions): http.Server {
  const lookup = options.lookup ?? defaultLookup;
  const isPrivate = options.isPrivate ?? isPrivateAddress;
  const log = options.log ?? ((line: string) => process.stderr.write(`egress-proxy: ${line}\n`));
  const server = http.createServer();

  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const target = parseAuthority(req.url ?? '');
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    void (async () => {
      const vetted = await vetHost(target.host, lookup, isPrivate);
      if (!vetted.ok) {
        log(`refused CONNECT to ${target.host}:${target.port}: ${vetted.reason}`);
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const gone = new AbortController();
      client.once('close', () => gone.abort());
      let upstream: net.Socket;
      try {
        upstream = await openFirst(vetted.addresses, target.port, options.upstream, gone.signal);
      } catch (err) {
        log(`could not reach ${target.host}:${target.port}: ${(err as Error).message}`);
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        return;
      }
      // Chrome may have hung up while the lookup or connect was pending; 'close' has
      // already fired then, so the listener below would never run.
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      upstream.setTimeout(TUNNEL_IDLE_MS, () => upstream.destroy());
      client.setTimeout(TUNNEL_IDLE_MS, () => client.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    })();
  });

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('egress-proxy: expected an absolute http:// URL');
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end('egress-proxy: only http:// is forwarded; use CONNECT for https');
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    void (async () => {
      const vetted = await vetHost(url.hostname, lookup, isPrivate);
      if (!vetted.ok) {
        log(`refused ${req.method} to ${url.hostname}:${port}: ${vetted.reason}`);
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked: private or internal address');
        return;
      }
      const gone = new AbortController();
      res.once('close', () => gone.abort());
      let socket: net.Socket;
      try {
        socket = await openFirst(vetted.addresses, port, options.upstream, gone.signal);
      } catch (err) {
        log(`could not reach ${url.hostname}:${port}: ${(err as Error).message}`);
        res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad gateway');
        return;
      }
      // Same gap as CONNECT: the client may be gone already, and 'close' will not fire again.
      if (res.destroyed || req.destroyed) {
        socket.destroy();
        return;
      }
      socket.setTimeout(TUNNEL_IDLE_MS, () => socket.destroy());
      res.on('close', () => socket.destroy());
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
      }
      const outbound = http.request({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        createConnection: () => socket,
      });
      outbound.on('response', (upstreamRes) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(name) && value !== undefined) out[name] = value;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, out);
        upstreamRes.pipe(res);
      });
      outbound.on('error', (err) => {
        log(`request to ${url.hostname}:${port} failed: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad gateway');
        else res.destroy();
      });
      req.pipe(outbound);
    })();
  });

  return server;
}

// -- Entry point ----------------------------------------------------------------------

export const DEFAULT_EGRESS_PROXY_PORT = 3128;

if (import.meta.main) {
  // --check: the image build loads the file and exits, so a syntax Node cannot strip
  // fails the build rather than the container.
  if (process.argv.includes('--check')) process.exit(0);
  const upstream = parseUpstream(process.env.BROWSER_PROXY);
  const port = Number(process.env.EGRESS_PROXY_PORT ?? DEFAULT_EGRESS_PROXY_PORT);
  const server = createEgressProxy({ upstream });
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`egress-proxy: listening on 127.0.0.1:${port}${upstream ? ` via ${upstream.protocol}://${upstream.host}:${upstream.port}` : ''}\n`);
  });
}
