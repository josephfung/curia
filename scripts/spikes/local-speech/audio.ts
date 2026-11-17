// WAV I/O and level helpers for the #2469 harness (16-bit mono PCM only).

import { readFileSync, writeFileSync } from 'node:fs';

export interface Wav {
  sampleRate: number;
  pcm: Int16Array;
}

export function readWav(path: string): Wav {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (channels !== 1 || bits !== 16) throw new Error(`${path}: need mono 16-bit, got ${channels}ch ${bits}-bit`);
      const end = Math.min(body + size, buf.length);
      const pcm = new Int16Array((end - body) / 2);
      for (let i = 0; i < pcm.length; i += 1) pcm[i] = buf.readInt16LE(body + i * 2);
      return { sampleRate, pcm };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

export function wavBytes(wav: Wav): Buffer {
  const data = Buffer.alloc(wav.pcm.length * 2);
  for (let i = 0; i < wav.pcm.length; i += 1) data.writeInt16LE(wav.pcm[i]!, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(wav.sampleRate, 24);
  header.writeUInt32LE(wav.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function writeWav(path: string, wav: Wav): void {
  writeFileSync(path, wavBytes(wav));
}

/** Deterministic PRNG so fixtures are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Frame-level dBFS over `windowMs` windows. */
export function frameDbfs(wav: Wav, windowMs = 10): number[] {
  const n = Math.max(1, Math.round((wav.sampleRate * windowMs) / 1000));
  const out: number[] = [];
  for (let i = 0; i + n <= wav.pcm.length; i += n) {
    let sum = 0;
    for (let j = i; j < i + n; j += 1) sum += (wav.pcm[j]! / 32768) ** 2;
    out.push(10 * Math.log10(sum / n + 1e-12));
  }
  return out;
}

/** First and last voiced ms (threshold relative to the loudest frame). */
export function speechSpan(wav: Wav, relDb = 35, floorDb = -55): { onsetMs: number; endMs: number } {
  const db = frameDbfs(wav, 10);
  const peak = Math.max(...db);
  const thr = Math.max(floorDb, peak - relDb);
  const first = db.findIndex(v => v >= thr);
  let last = db.length - 1;
  while (last > 0 && db[last]! < thr) last -= 1;
  return { onsetMs: Math.max(0, first) * 10, endMs: (last + 1) * 10 };
}

/** Pad with silence and add a seeded Gaussian noise floor at `noiseDbfs`. */
export function padWithNoise(wav: Wav, leadMs: number, tailMs: number, noiseDbfs: number, seed: number): Wav {
  const lead = Math.round((wav.sampleRate * leadMs) / 1000);
  const tail = Math.round((wav.sampleRate * tailMs) / 1000);
  const out = new Int16Array(lead + wav.pcm.length + tail);
  out.set(wav.pcm, lead);
  const rand = mulberry32(seed);
  const sigma = 32768 * 10 ** (noiseDbfs / 20);
  for (let i = 0; i < out.length; i += 1) {
    const g = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    out[i] = Math.max(-32768, Math.min(32767, Math.round(out[i]! + g * sigma)));
  }
  return { sampleRate: wav.sampleRate, pcm: out };
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}
