// Guards the LiveKit wiring the installer relies on (#2357): the shipped configs
// carry no keys (LIVEKIT_KEYS supplies them at runtime), compose mounts them
// read-only, and the Caddyfile routes call signaling to livekit.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

interface LivekitConfig {
  keys?: unknown;
  rtc: { use_external_ip: boolean; udp_port: number; tcp_port: number };
  room: { empty_timeout: number };
}
interface ComposeFile {
  services: Record<
    string,
    {
      volumes?: string[];
      environment?: Record<string, string>;
      command?: string;
      profiles?: string[];
    }
  >;
}

const compose = yaml.load(read('docker-compose.yml')) as ComposeFile;
const livekit = compose.services['livekit']!;

describe('compose livekit service', () => {
  it('mounts the shipped config read-only', () => {
    expect(livekit.volumes).toContain('./docker/livekit.yaml:/etc/livekit.yaml:ro');
  });

  it('mounts the local config read-only', () => {
    expect(livekit.volumes).toContain('./docker/livekit.local.yaml:/etc/livekit.local.yaml:ro');
  });

  it('passes LIVEKIT_KEYS through', () => {
    expect(livekit.environment?.['LIVEKIT_KEYS']).toBe('${LIVEKIT_KEYS:-}');
  });

  it('keeps the --dev fallback and the voice profile', () => {
    expect(livekit.command).toBe('${LIVEKIT_COMMAND:---dev --bind 0.0.0.0}');
    expect(livekit.profiles).toEqual(['voice']);
  });
});

describe('shipped livekit configs', () => {
  it('shipped livekit.yaml carries no keys', () => {
    const cfg = yaml.load(read('docker/livekit.yaml')) as LivekitConfig;
    expect(cfg).not.toHaveProperty('keys');
    expect(cfg.rtc.use_external_ip).toBe(true);
    expect(cfg.rtc.udp_port).toBe(7882);
    expect(cfg.rtc.tcp_port).toBe(7881);
    expect(cfg.room.empty_timeout).toBe(30);
  });

  it('shipped livekit.local.yaml carries no keys and turns use_external_ip off', () => {
    const cfg = yaml.load(read('docker/livekit.local.yaml')) as LivekitConfig;
    expect(cfg).not.toHaveProperty('keys');
    expect(cfg.rtc.use_external_ip).toBe(false);
    expect(cfg.rtc.udp_port).toBe(7882);
    expect(cfg.rtc.tcp_port).toBe(7881);
    expect(cfg.room.empty_timeout).toBe(30);
  });
});

describe('Caddyfile', () => {
  it('routes /rtc* to livekit before the catch-all', () => {
    const text = read('deploy/Caddyfile');
    const rtc = /handle \/rtc\* \{\s*reverse_proxy livekit:7880\s*\}/.exec(text);
    expect(rtc).not.toBeNull();
    const catchAll = text.indexOf('reverse_proxy curia:3000');
    expect(catchAll).toBeGreaterThan(-1);
    expect(rtc!.index).toBeLessThan(catchAll);
    expect(text).toMatch(/handle \{\s*reverse_proxy curia:3000\s*\}/);
  });
});
