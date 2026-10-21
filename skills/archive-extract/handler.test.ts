import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { ArchiveExtractHandler } from './handler.js';
import { FileParseHandler } from '../file-parse/handler.js';
import { TempFileStore } from '../../src/skills/temp-file-store.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { InfraLlm, InfraLlmResult } from '../../src/skills/infra-llm.js';

const TEMPFILES_BASE = '/tmp/curia-tempfiles';
const DMARC_XML_URL = new URL('./__fixtures__/dmarc-report.xml', import.meta.url);

interface ZipMember {
  name: string;
  data: Buffer;
  method?: 'store' | 'deflate';
  /** Uncompressed size written into the headers. Defaults to data.length. */
  declaredUncompressedSize?: number;
  encrypted?: boolean;
  /** Unix mode, e.g. 0o120777 for a symlink. Sets the "made by Unix" version too. */
  unixMode?: number;
  /** Made-by host for a `unixMode` entry. Defaults to 3 (Unix); 19 is OS X/Darwin. */
  madeByHost?: number;
}

function buildZip(members: ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const nameBuf = Buffer.from(member.name, 'utf8');
    const method = member.method === 'store' ? 0 : 8;
    const payload = method === 0 ? member.data : zlib.deflateRawSync(member.data);
    const crc = zlib.crc32(member.data) >>> 0;
    let flags = 0x800;
    if (member.encrypted) flags |= 0x1;
    const uncompressedSize = member.declaredUncompressedSize ?? member.data.length;
    const versionMadeBy = member.unixMode != null ? (((member.madeByHost ?? 3) << 8) | 20) : 20;
    const external = member.unixMode != null ? (member.unixMode << 16) >>> 0 : 0;

    const local = Buffer.alloc(30 + nameBuf.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    payload.copy(local, 30 + nameBuf.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

/** Repeating pattern that deflates well under 100:1, so a size cap trips before the ratio cap. */
function patterned(bytes: number): Buffer {
  const data = Buffer.alloc(bytes);
  for (let i = 0; i < data.length; i++) data[i] = (i * 17 + (i >> 8)) & 0xff;
  return data;
}

function makeInfraLlm(): InfraLlm {
  return {
    classify: vi.fn().mockResolvedValue({ ok: true, text: '{}' } as InfraLlmResult),
    extract: vi.fn().mockResolvedValue({ ok: true, text: '{}' } as InfraLlmResult),
  };
}

describe('ArchiveExtractHandler', () => {
  const handler = new ArchiveExtractHandler();
  let tempDir: string;
  let store: TempFileStore;
  let outsideDir: string;
  let dmarcXml: Buffer;

  beforeAll(async () => {
    await fs.mkdir(TEMPFILES_BASE, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(TEMPFILES_BASE, 'archive-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'curia-not-store-'));
    store = new TempFileStore({ dir: tempDir, sweepIntervalMs: 0 });
    dmarcXml = await fs.readFile(DMARC_XML_URL);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  function ctx(input: Record<string, unknown>, writeTempFile = vi.fn(store.write.bind(store))): ToolContext & { writeTempFile: ReturnType<typeof vi.fn> } {
    const fn = writeTempFile;
    return {
      input,
      secret: () => '',
      log: pino({ level: 'silent' }),
      writeTempFile: fn,
    } as unknown as ToolContext & { writeTempFile: ReturnType<typeof vi.fn> };
  }

  async function stage(bytes: Buffer, filename: string): Promise<string> {
    return store.write(bytes, filename);
  }

  async function listing(): Promise<string[]> {
    return (await fs.readdir(tempDir)).sort();
  }

  it('extracts a Google-style DMARC zip to one XML entry that file-parse reads', async () => {
    const xmlName = 'google.com!example.com!1711929600!1712016000.xml';
    const zipName = 'google.com!example.com!1711929600!1712016000.zip';
    const zip = buildZip([{ name: xmlName, data: dmarcXml }]);
    // The download tool's output: a temp-store URL plus the attachment filename.
    const tempFileUrl = await stage(zip, zipName);
    const extractCtx = ctx({ temp_file_url: tempFileUrl, mime_type: 'application/zip', filename: zipName });
    const extracted = await handler.execute(extractCtx);
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const data = extracted.data as {
      entries: Array<{ filename: string; mime_type: string; size_bytes: number; temp_file_url: string }>;
    };
    expect(data.entries).toHaveLength(1);
    const entry = data.entries[0]!;
    expect(entry.filename).toBe(xmlName);
    expect(entry.mime_type).toBe('application/xml');
    expect(entry.size_bytes).toBe(dmarcXml.length);

    const infraLlm = makeInfraLlm();
    const parsed = await new FileParseHandler().execute({
      input: { temp_file_url: entry.temp_file_url, mime_type: entry.mime_type, filename: entry.filename },
      secret: () => '',
      log: pino({ level: 'silent' }),
      infraLlm,
    } as unknown as ToolContext);
    expect(parsed.success).toBe(true);
    expect(infraLlm.extract).not.toHaveBeenCalled();
    if (parsed.success) {
      const body = parsed.data as { type: string; raw_text: string };
      expect(body.type).toBe('xml');
      expect(body.raw_text).toContain('<dkim>pass</dkim>');
      expect(body.raw_text).toContain('<spf>pass</spf>');
    }
  });

  it('extracts a Microsoft-style DMARC .xml.gz the same way', async () => {
    const gzName = 'google.com!example.com!1711929600!1712016000.xml.gz';
    const gz = zlib.gzipSync(dmarcXml);
    const tempFileUrl = await stage(gz, gzName);
    const extracted = await handler.execute(ctx({
      temp_file_url: tempFileUrl,
      mime_type: 'application/gzip',
      filename: gzName,
    }));
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const entry = (extracted.data as { entries: Array<{ filename: string; mime_type: string; temp_file_url: string }> }).entries[0]!;
    expect(entry.filename).toBe('google.com!example.com!1711929600!1712016000.xml');
    expect(entry.mime_type).toBe('application/xml');

    const infraLlm = makeInfraLlm();
    const parsed = await new FileParseHandler().execute({
      input: { temp_file_url: entry.temp_file_url, mime_type: entry.mime_type, filename: entry.filename },
      secret: () => '',
      log: pino({ level: 'silent' }),
      infraLlm,
    } as unknown as ToolContext);
    expect(parsed.success).toBe(true);
    expect(infraLlm.extract).not.toHaveBeenCalled();
    if (parsed.success) {
      expect((parsed.data as { raw_text: string }).raw_text).toContain('<org_name>google.com</org_name>');
    }
  });

  it('treats an octet-stream .xml.gz as gzip', async () => {
    const gz = zlib.gzipSync(Buffer.from('<feedback/>'));
    const tempFileUrl = await stage(gz, 'report.xml.gz');
    const extracted = await handler.execute(ctx({
      temp_file_url: tempFileUrl,
      mime_type: 'application/octet-stream',
      filename: 'report.xml.gz',
    }));
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const entry = (extracted.data as { entries: Array<{ filename: string; mime_type: string }> }).entries[0]!;
    expect(entry.filename).toBe('report.xml');
    expect(entry.mime_type).toBe('application/xml');
  });

  it('gives a .md inside a zip a markdown type that file-parse reads end to end', async () => {
    const markdown = '# Notes\n\nBring the report.';
    const zip = buildZip([{ name: 'notes.md', data: Buffer.from(markdown) }]);
    const tempFileUrl = await stage(zip, 'notes.zip');
    const extracted = await handler.execute(ctx({
      temp_file_url: tempFileUrl,
      mime_type: 'application/zip',
      filename: 'notes.zip',
    }));
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const entry = (extracted.data as { entries: Array<{ filename: string; mime_type: string; temp_file_url: string }> }).entries[0]!;
    expect(entry.filename).toBe('notes.md');
    expect(entry.mime_type).toBe('text/markdown');
    const infraLlm = makeInfraLlm();
    const parsed = await new FileParseHandler().execute({
      input: { temp_file_url: entry.temp_file_url, mime_type: entry.mime_type, filename: entry.filename },
      secret: () => '',
      log: pino({ level: 'silent' }),
      infraLlm,
    } as unknown as ToolContext);
    expect(parsed.success).toBe(true);
    expect(infraLlm.extract).not.toHaveBeenCalled();
    if (parsed.success) {
      const body = parsed.data as { type: string; raw_text: string };
      expect(body.type).toBe('markdown');
      expect(body.raw_text).toBe(markdown);
    }
  });

  describe('rejects without leaving extracted files', () => {
    async function expectRejected(bytes: Buffer, filename: string, mime: string, pattern: RegExp) {
      const before = await listing();
      const extractCtx = ctx({ temp_file_url: await stage(bytes, filename), mime_type: mime, filename });
      const result = await handler.execute(extractCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(pattern);
      expect(extractCtx.writeTempFile).not.toHaveBeenCalled();
      // The staged archive is the only new file. Nothing extracted was kept.
      const after = await listing();
      expect(after.length).toBe(before.length + 1);
    }

    it('rejects a zip decompression bomb', async () => {
      const zip = buildZip([{ name: 'bomb.txt', data: Buffer.alloc(2 * 1024 * 1024, 0) }]);
      await expectRejected(zip, 'bomb.zip', 'application/zip', /compression ratio exceeds 100:1/);
    });

    it('rejects a gzip decompression bomb', async () => {
      const gz = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 0));
      await expectRejected(gz, 'bomb.gz', 'application/gzip', /compression ratio exceeds 100:1/);
    });

    it('rejects a zip whose header says the entry is tiny but it inflates past 10 MB', async () => {
      const zip = buildZip([{
        name: 'lie.bin',
        data: patterned(11 * 1024 * 1024),
        declaredUncompressedSize: 64,
      }]);
      await expectRejected(zip, 'lie.zip', 'application/zip', /entry "lie\.bin" exceeds 10 MB uncompressed/);
    });

    it('rejects a gzip whose ISIZE says the member is tiny but it inflates past 10 MB', async () => {
      const gz = zlib.gzipSync(patterned(11 * 1024 * 1024));
      gz.writeUInt32LE(64, gz.length - 4);
      await expectRejected(gz, 'lie.xml.gz', 'application/gzip', /exceeds 10 MB uncompressed/);
    });

    it('rejects an archive with more than 20 entries', async () => {
      const zip = buildZip(Array.from({ length: 21 }, (_, i) => ({
        name: `f${i}.txt`,
        data: Buffer.from('x'),
        method: 'store' as const,
      })));
      await expectRejected(zip, 'many.zip', 'application/zip', /more than 20 entries/);
    });

    it('rejects an encrypted entry and does not return the other files', async () => {
      const zip = buildZip([
        { name: 'plain.txt', data: Buffer.from('visible') },
        { name: 'secret.xml', data: Buffer.from('hidden'), encrypted: true },
      ]);
      await expectRejected(zip, 'mixed.zip', 'application/zip', /entry "secret\.xml" is encrypted/);
    });

    it('rejects a gzip with more than one member', async () => {
      const gz = Buffer.concat([
        zlib.gzipSync(Buffer.from('one')),
        zlib.gzipSync(Buffer.from('two')),
      ]);
      await expectRejected(gz, 'multi.gz', 'application/gzip', /multiple members/);
    });
  });

  it('extracts a small file whose header claims a 100 MB uncompressed size', async () => {
    const zip = buildZip([{
      name: 'hello.txt',
      data: Buffer.from('hello'),
      declaredUncompressedSize: 100_000_000,
    }]);
    const extracted = await handler.execute(ctx({
      temp_file_url: await stage(zip, 'honest.zip'),
      mime_type: 'application/zip',
      filename: 'honest.zip',
    }));
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const entry = (extracted.data as { entries: Array<{ size_bytes: number; temp_file_url: string }> }).entries[0]!;
    expect(entry.size_bytes).toBe(5);
    const body = await fs.readFile(entry.temp_file_url.slice('file://'.length));
    expect(body.toString()).toBe('hello');
  });

  it('returns a gzip member whole when the ISIZE trailer understates it', async () => {
    const gz = zlib.gzipSync(Buffer.from('hello'));
    gz.writeUInt32LE(1, gz.length - 4);
    const extracted = await handler.execute(ctx({
      temp_file_url: await stage(gz, 'short.xml.gz'),
      mime_type: 'application/gzip',
      filename: 'short.xml.gz',
    }));
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const entry = (extracted.data as { entries: Array<{ filename: string; temp_file_url: string }> }).entries[0]!;
    expect(entry.filename).toBe('short.xml');
    const body = await fs.readFile(entry.temp_file_url.slice('file://'.length));
    expect(body.toString()).toBe('hello');
  });

  it('sanitizes traversal, absolute, and control-character entry names', async () => {
    const sentinel = path.join(outsideDir, 'passwd');
    await fs.writeFile(sentinel, 'keep');
    const zip = buildZip([
      { name: '../../etc/passwd', data: Buffer.from('trav-a') },
      { name: '/var/absolute.txt', data: Buffer.from('trav-b') },
      { name: 'bad\u0000name\u0007.xml', data: Buffer.from('trav-c') },
    ]);
    const extractCtx = ctx({
      temp_file_url: await stage(zip, 'names.zip'),
      mime_type: 'application/zip',
      filename: 'names.zip',
    });
    const extracted = await handler.execute(extractCtx);
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const entries = (extracted.data as { entries: Array<{ filename: string; temp_file_url: string }> }).entries;
    expect(entries.map((entry) => entry.filename).sort()).toEqual(['absolute.txt', 'badname.xml', 'passwd']);
    const names = extractCtx.writeTempFile.mock.calls.map((call) => call[1]);
    for (const name of names) {
      expect(name).not.toContain('..');
      expect(name).not.toContain('/');
      expect(name).not.toContain('\u0000');
    }
    const byName = new Map(entries.map((entry) => [entry.filename, entry.temp_file_url]));
    expect(await fs.readFile(byName.get('passwd')!.slice('file://'.length), 'utf8')).toBe('trav-a');
    expect(await fs.readFile(byName.get('absolute.txt')!.slice('file://'.length), 'utf8')).toBe('trav-b');
    expect(await fs.readFile(byName.get('badname.xml')!.slice('file://'.length), 'utf8')).toBe('trav-c');
    expect(await fs.readFile(sentinel, 'utf8')).toBe('keep');
    const outsideNames = await fs.readdir(outsideDir);
    expect(outsideNames).toEqual(['passwd']);
    for (const entry of entries) {
      expect(entry.temp_file_url.startsWith(`file://${tempDir}/`)).toBe(true);
    }
  });

  it('lists a nested zip and a nested gzip without opening them', async () => {
    const innerZip = buildZip([{ name: 'secret.txt', data: Buffer.from('TOP SECRET') }]);
    const innerGz = zlib.gzipSync(Buffer.from('INNER TEXT'));
    const zip = buildZip([
      { name: 'inner.zip', data: innerZip, method: 'store' },
      { name: 'report.xml.gz', data: innerGz, method: 'store' },
    ]);
    const extracted = await handler.execute(ctx({
      temp_file_url: await stage(zip, 'outer.zip'),
      mime_type: 'application/zip',
      filename: 'outer.zip',
    }));
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const entries = (extracted.data as { entries: Array<{ filename: string; temp_file_url: string }> }).entries;
    expect(entries.map((entry) => entry.filename).sort()).toEqual(['inner.zip', 'report.xml.gz']);
    const byName = new Map(entries.map((entry) => [entry.filename, entry.temp_file_url]));
    const zipBytes = await fs.readFile(byName.get('inner.zip')!.slice('file://'.length));
    const gzBytes = await fs.readFile(byName.get('report.xml.gz')!.slice('file://'.length));
    expect(zipBytes.subarray(0, 2).toString()).toBe('PK');
    expect(gzBytes[0]).toBe(0x1f);
    expect(gzBytes[1]).toBe(0x8b);
    expect(zipBytes.equals(Buffer.from('TOP SECRET'))).toBe(false);
    expect(gzBytes.equals(Buffer.from('INNER TEXT'))).toBe(false);
  });

  it('skips directories, symlinks, and other non-regular entries', async () => {
    const zip = buildZip([
      { name: 'nested/', data: Buffer.alloc(0), method: 'store' },
      { name: 'via-link', data: Buffer.from('outside-target'), unixMode: 0o120777 },
      { name: 'the-fifo', data: Buffer.alloc(0), method: 'store', unixMode: 0o010666 },
      { name: 'keep.txt', data: Buffer.from('kept') },
    ]);
    const extractCtx = ctx({
      temp_file_url: await stage(zip, 'skip.zip'),
      mime_type: 'application/zip',
      filename: 'skip.zip',
    });
    const extracted = await handler.execute(extractCtx);
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const data = extracted.data as {
      entries: Array<{ filename: string }>;
      skipped: Array<{ filename: string; reason: string }>;
    };
    expect(data.entries.map((entry) => entry.filename)).toEqual(['keep.txt']);
    expect(data.skipped).toEqual([
      { filename: 'nested', reason: 'directory' },
      { filename: 'via-link', reason: 'symlink' },
      { filename: 'the-fifo', reason: 'not a regular file' },
    ]);
    expect(extractCtx.writeTempFile).toHaveBeenCalledTimes(1);
    expect(extractCtx.writeTempFile.mock.calls[0]?.[1]).toBe('keep.txt');
  });

  it('reads Unix mode bits from OS X (made-by host 19) entries too', async () => {
    const zip = buildZip([
      { name: 'mac-link', data: Buffer.from('outside-target'), unixMode: 0o120755, madeByHost: 19 },
      { name: 'mac-fifo', data: Buffer.alloc(0), method: 'store', unixMode: 0o010644, madeByHost: 19 },
      { name: 'mac.txt', data: Buffer.from('kept'), unixMode: 0o100644, madeByHost: 19 },
    ]);
    const extractCtx = ctx({
      temp_file_url: await stage(zip, 'mac.zip'),
      mime_type: 'application/zip',
      filename: 'mac.zip',
    });
    const extracted = await handler.execute(extractCtx);
    expect(extracted.success).toBe(true);
    if (!extracted.success) return;
    const data = extracted.data as {
      entries: Array<{ filename: string }>;
      skipped: Array<{ filename: string; reason: string }>;
    };
    expect(data.entries.map((entry) => entry.filename)).toEqual(['mac.txt']);
    expect(data.skipped).toEqual([
      { filename: 'mac-link', reason: 'symlink' },
      { filename: 'mac-fifo', reason: 'not a regular file' },
    ]);
    expect(extractCtx.writeTempFile).toHaveBeenCalledTimes(1);
  });

  it('rejects an archive total past 25 MB uncompressed', async () => {
    const chunk = patterned(9 * 1024 * 1024);
    const zip = buildZip([
      { name: 'a.bin', data: chunk },
      { name: 'b.bin', data: chunk },
      { name: 'c.bin', data: chunk },
    ]);
    const before = await listing();
    const extractCtx = ctx({
      temp_file_url: await stage(zip, 'total.zip'),
      mime_type: 'application/zip',
      filename: 'total.zip',
    });
    const result = await handler.execute(extractCtx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/archive exceeds 25 MB uncompressed/);
    expect(extractCtx.writeTempFile).not.toHaveBeenCalled();
    expect((await listing()).length).toBe(before.length + 1);
  });

  it('rejects a temp_file_url outside the temp store', async () => {
    const result = await handler.execute(ctx({
      temp_file_url: 'file:///etc/passwd',
      mime_type: 'application/zip',
      filename: 'passwd.zip',
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/invalid temp_file_url/i);
  });

  it('rejects a temp_file_url that escapes via path traversal', async () => {
    const result = await handler.execute(ctx({
      temp_file_url: 'file:///tmp/curia-tempfiles/../../etc/passwd',
      mime_type: 'application/zip',
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/invalid temp_file_url/i);
  });

  it('rejects a symlink inside the temp store that points outside it', async () => {
    const target = path.join(outsideDir, 'secret');
    await fs.writeFile(target, 'CANARY');
    const link = path.join(tempDir, 'escape.zip');
    await fs.symlink(target, link);
    const extractCtx = ctx({
      temp_file_url: `file://${link}`,
      mime_type: 'application/zip',
      filename: 'escape.zip',
    });
    const result = await handler.execute(extractCtx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/invalid temp_file_url/i);
      expect(result.error).not.toContain('CANARY');
    }
    expect(extractCtx.writeTempFile).not.toHaveBeenCalled();
  });
});
