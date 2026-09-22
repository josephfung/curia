/**
 * docker-publish retries a transient SBOM-scanner pull without retrying a
 * broken build (curia#1864).
 *
 * The behaviour itself is pinned by tests/docker/test-buildx-retry.sh, which
 * forces the failure. This file pins the wiring: the retry stays inside the
 * build step (so a recovered attempt is a green job and notify-failure stays
 * quiet), the job wall stays 60 minutes, and both images still request an SBOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = join(import.meta.dirname, '../../..');

interface BuildStep {
  id?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
}

interface Workflow {
  jobs: {
    build: {
      'timeout-minutes': number;
      permissions: Record<string, string>;
      steps: BuildStep[];
    };
    'notify-failure': {
      if: string;
      needs: string[];
    };
  };
}

const workflow = yaml.load(
  readFileSync(join(ROOT, '.github/workflows/docker-publish.yml'), 'utf8'),
) as Workflow;

describe('docker-publish retry wiring (#1864)', () => {
  const build = workflow.jobs.build;
  const step = build.steps.find((candidate) => candidate.id === 'build');

  it('retries inside the build step, so a recovered attempt stays a success', () => {
    expect(step?.run).toBe('bash docker/publish-image.sh');
    expect(step?.['continue-on-error']).toBeUndefined();
    expect(step?.if ?? '').not.toMatch(/always\s*\(/);
  });

  it('keeps the 60 minute wall and can write the Actions cache', () => {
    expect(build['timeout-minutes']).toBe(60);
    expect(build.permissions.actions).toBe('write');
    expect(build.permissions.packages).toBe('write');
    expect(build.permissions['id-token']).toBe('write');
    expect(build.permissions.contents).toBe('read');
  });

  it('still requests an SBOM and max provenance, scoped per image', () => {
    const script = readFileSync(join(ROOT, 'docker/publish-image.sh'), 'utf8');
    expect(script).toContain('type=sbom');
    expect(script).toContain('type=provenance,mode=max');
    expect(script).toContain('type=gha,mode=max,scope=${CACHE_SCOPE},ignore-error=true');
    expect(script).toContain('buildx-retry.sh');
  });

  it('alerts only when the build job failed', () => {
    const notify = workflow.jobs['notify-failure'];
    expect(notify.if).toBe("always() && needs.build.result == 'failure'");
    expect(notify.needs).toEqual(['resolve', 'build']);
  });

  it('caps the outer retry at three attempts and refuses an unclassified failure', () => {
    const retry = readFileSync(join(ROOT, 'docker/buildx-retry.sh'), 'utf8');
    expect(retry).toContain('BUILDX_RETRY_ATTEMPTS:-3');
    expect(retry).toContain('not retrying');
  });
});
