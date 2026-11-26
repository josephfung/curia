// Guards the config/local.yaml mount the installers rely on (#2749): the image never
// contains local.yaml (.dockerignore), so the models an OpenRouter or Bedrock install
// writes there reach the container only through this mount.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '../../..');

interface BindMount {
  type?: string;
  source?: string;
  target?: string;
  read_only?: boolean;
  bind?: { create_host_path?: boolean };
}
interface ComposeFile {
  services: Record<string, { volumes?: Array<string | BindMount> }>;
}

const compose = yaml.load(readFileSync(resolve(root, 'docker-compose.yml'), 'utf8')) as ComposeFile;

describe('compose curia service: config/local.yaml', () => {
  const mount = compose.services['curia']!.volumes?.find(
    (v): v is BindMount => typeof v === 'object' && v.target === '/app/config/local.yaml',
  );

  it('bind-mounts ./config/local.yaml read-only where loadYamlConfig reads it', () => {
    expect(mount).toMatchObject({ type: 'bind', source: './config/local.yaml', read_only: true });
  });

  it('refuses a missing file instead of mounting a directory in its place', () => {
    expect(mount?.bind?.create_host_path).toBe(false);
  });

  it('is kept out of the image', () => {
    expect(readFileSync(resolve(root, '.dockerignore'), 'utf8').split('\n')).toContain('config/local.yaml');
  });
});
