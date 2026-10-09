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
  run?: string;
  name?: string;
  uses?: string;
  if?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, string>;
}

interface Workflow {
  jobs: { build: { steps: Step[] } };
}

const load = <T>(name: string): T =>
  yaml.load(readFileSync(join(ROOT, '.github/workflows', name), 'utf8')) as T;

const workflow = load<Workflow>('docker-publish.yml');

const SECRETS = {
  username: '${{ secrets.DOCKERHUB_USERNAME }}',
  password: '${{ secrets.DOCKERHUB_TOKEN }}',
};

interface ContainerSpec {
  image: string;
  credentials?: Record<string, string>;
}

interface CheckJob {
  container?: ContainerSpec;
  services?: Record<string, ContainerSpec>;
  env?: Record<string, string>;
  steps: Step[];
}

type CheckWorkflow = { jobs: Record<string, CheckJob> };

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

// The PR checks pull from Docker Hub too, and failed on the same rate limit. They
// authenticate where the secrets exist and pull anonymously where they do not
// (fork and Dependabot PRs): the runner skips a container login whose credentials
// are empty, and the postgres-image login step is skipped by its `if:`.
describe('PR-check Docker Hub pulls (#2095)', () => {
  const ci = load<CheckWorkflow>('ci.yml');

  it.each([
    ['ci.yml', 'ci', 'postgres'],
    ['dast.yml', 'zap-baseline', 'postgres'],
  ])('%s authenticates its %s job\'s %s service', (file, job, service) => {
    const spec = load<CheckWorkflow>(file).jobs[job]!.services![service]!;
    expect(spec.image).toMatch(/^pgvector\//);
    expect(spec.credentials).toEqual(SECRETS);
  });

  it('semgrep authenticates its container', () => {
    const container = load<CheckWorkflow>('semgrep.yml').jobs.semgrep!.container!;
    expect(container.image).toBe('semgrep/semgrep');
    expect(container.credentials).toEqual(SECRETS);
  });

  it('ci postgres-image logs in before the build, only where the secret exists', () => {
    const job = ci.jobs['postgres-image']!;
    const loginIndex = job.steps.findIndex(
      (step) => step.uses?.startsWith('docker/login-action@') && step.with?.registry === 'docker.io',
    );
    const buildIndex = job.steps.findIndex((step) => step.run?.includes('test-postgres-init.sh'));
    expect(loginIndex).toBeGreaterThan(-1);
    expect(loginIndex).toBeLessThan(buildIndex);
    const login = job.steps[loginIndex]!;
    expect(login.with).toMatchObject({ username: SECRETS.username, password: SECRETS.password });
    expect(login.if).toBe("env.DOCKERHUB_USERNAME != ''");
    expect(job.env?.DOCKERHUB_USERNAME).toBe(SECRETS.username);
  });
});
