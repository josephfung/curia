/**
 * docker-publish builds each platform on a runner of that architecture (build-arch), then
 * joins and signs each image (build). The arm64 legs used to run under QEMU on amd64, most of
 * a 14-minute publish on every merge to main.
 *
 * These pin the parts that would publish something wrong without failing: the two jobs'
 * image lists and tags agree (labels come from build-arch's copy, tags from build's), every
 * leg runs natively, an image is assembled only from its own legs' digests, and the tags are
 * written only once every platform is in.
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
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean | number>;
}

interface MatrixEntry {
  name: string;
  image: string;
  dockerfile: string;
  expects_semver: boolean;
  tags: string;
}

interface Job {
  needs?: string | string[];
  if?: string;
  'runs-on': string;
  strategy?: { 'fail-fast'?: boolean; matrix: { image?: string[]; arch?: string[]; include: MatrixEntry[] } };
  steps: Step[];
}

const workflow = yaml.load(
  readFileSync(join(ROOT, '.github/workflows/docker-publish.yml'), 'utf8'),
) as { jobs: Record<string, Job> };

const arch = workflow.jobs['build-arch']!;
const build = workflow.jobs.build!;
const stepById = (job: Job, id: string): Step | undefined => job.steps.find((s) => s.id === id);

describe('docker-publish native per-architecture builds', () => {
  it('builds every image of `build` on both architectures, with the same tags', () => {
    const images = build.strategy!.matrix.include;
    expect(arch.strategy!.matrix.image).toEqual(images.map((e) => e.image));
    expect(arch.strategy!.matrix.arch).toEqual(['amd64', 'arm64']);
    expect(arch.strategy!.matrix.include).toEqual(images);
    expect(arch.strategy!['fail-fast']).toBe(false);
  });

  it('runs each leg on a runner of its own architecture, and nothing emulates one', () => {
    expect(arch['runs-on']).toBe("${{ matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-latest' }}");
    for (const job of Object.values(workflow.jobs)) {
      expect(job.steps?.some((s) => s.uses?.startsWith('docker/setup-qemu-action@')) ?? false).toBe(false);
    }
  });

  it('stamps the same labels as the tags it will get', () => {
    // build-arch's labels go into each platform's image config; build's meta makes the tags.
    expect(stepById(arch, 'meta')?.with).toEqual(stepById(build, 'meta')?.with);
  });

  it('pushes each platform untagged, with its own layer cache', () => {
    const env = stepById(arch, 'build')!.env!;
    expect(env.PUSH_BY_DIGEST).toBe('true');
    expect(env.PLATFORMS).toBe('linux/${{ matrix.arch }}');
    expect(env.TAGS).toBeUndefined();
    expect(env.CACHE_SCOPE).toBe('${{ matrix.image }}-${{ matrix.arch }}');
  });

  it('assembles an image from its own legs only, one exact artifact per architecture', () => {
    const upload = arch.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toBe('digest-${{ matrix.image }}-${{ matrix.arch }}');
    const downloads = build.steps.filter((s) => s.uses?.startsWith('actions/download-artifact@'));
    // A `pattern:` such as digest-curia-* would also match curia-browser's digests.
    expect(downloads.map((s) => s.with?.name)).toEqual(['digest-${{ matrix.image }}-amd64', 'digest-${{ matrix.image }}-arm64']);
    for (const d of downloads) expect(d.with?.pattern).toBeUndefined();
  });

  it('writes tags only after every leg, and still runs (to fail and alert) when one failed', () => {
    expect(build.needs).toEqual(['resolve', 'build-arch']);
    expect(build.if).toBe("${{ !cancelled() && needs.resolve.result == 'success' }}");
    const assemble = stepById(build, 'build')!;
    expect(assemble.run).toBe('bash docker/assemble-image.sh');
    expect(assemble.env?.TAGS).toBe('${{ steps.meta.outputs.tags }}');
    // Tag and digest values reach the shell through env, never interpolated into it.
    for (const job of [arch, build]) {
      for (const s of job.steps) expect(s.run ?? '').not.toMatch(/\$\{\{/);
    }
  });
});
