/**
 * docker-publish pulls from Docker Hub as an authenticated user (curia#2095).
 *
 * Anonymous pulls are rate-limited per IP, and GitHub's hosted runners share
 * IPs, so a publish could fail with 429 on a merge that changed no image input.
 * This pins the login: it exists, it reads the Docker Hub secrets, it runs
 * before anything that pulls (QEMU, BuildKit, the build), and it cannot be
 * skipped or ignored, so a missing token fails loudly at the login instead of
 * silently falling back to anonymous pulls.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = join(import.meta.dirname, '../../..');

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, string>;
}

interface Workflow {
  jobs: { build: { steps: Step[] } };
}

const workflow = yaml.load(
  readFileSync(join(ROOT, '.github/workflows/docker-publish.yml'), 'utf8'),
) as Workflow;

describe('docker-publish Docker Hub login (#2095)', () => {
  const steps = workflow.jobs.build.steps;
  const loginIndex = steps.findIndex(
    (step) => step.uses?.startsWith('docker/login-action@') && step.with?.registry === 'docker.io',
  );
  const login = steps[loginIndex];
  const indexOf = (match: (step: Step) => boolean): number => steps.findIndex(match);

  it('logs in to Docker Hub with the repo secrets', () => {
    expect(login).toBeDefined();
    expect(login!.with?.username).toBe('${{ secrets.DOCKERHUB_USERNAME }}');
    expect(login!.with?.password).toBe('${{ secrets.DOCKERHUB_TOKEN }}');
  });

  it('cannot be skipped or ignored', () => {
    expect(login!.if).toBeUndefined();
    expect(login!['continue-on-error']).toBeUndefined();
  });

  it('runs before every step that pulls from Docker Hub', () => {
    const pulls = [
      indexOf((step) => step.uses?.startsWith('docker/setup-qemu-action@') ?? false),
      indexOf((step) => step.uses?.startsWith('docker/setup-buildx-action@') ?? false),
      indexOf((step) => step.id === 'build'),
    ];
    for (const index of pulls) {
      expect(index).toBeGreaterThan(-1);
      expect(loginIndex).toBeLessThan(index);
    }
  });
});
