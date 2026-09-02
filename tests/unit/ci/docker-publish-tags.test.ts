/**
 * Which image tags `docker-publish.yml` writes, per trigger (curia#1715).
 *
 * Why a test for a YAML file: the tags this workflow publishes are decided by
 * GitHub expressions that only evaluate inside a real run, and `:edge` is what
 * production consumes by default. #1715 sat latent for months precisely because
 * nothing exercised the `workflow_dispatch` path — a dispatch carrying
 * `tag: v0.40.0` built the old release's source and published it as `:edge`,
 * moving the "newest main" pointer *backwards* onto code whose migrations had
 * already run against prod, while publishing no semver tag at all.
 *
 * The root cause is that `github.ref` / `github.event_name` describe where a run
 * was *launched from*, not what got checked out. So these tests render the tag
 * expressions against a simulated context for each trigger and assert the
 * resulting tag set. Verifying by dispatching the real workflow costs a ~10min
 * multi-arch build and a throwaway tag; this costs milliseconds and runs on
 * every PR.
 *
 * The mini expression evaluator below covers only the constructs this workflow
 * actually uses, and throws on anything else. That is deliberate: an evaluator
 * that silently ignored a construct it did not understand would let this test
 * stay green while the workflow did something entirely different.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const WORKFLOW_PATH = join(import.meta.dirname, '../../../.github/workflows/docker-publish.yml');

interface MatrixEntry {
  name: string;
  image: string;
  dockerfile: string;
  tags: string;
}

interface Workflow {
  concurrency: { group: string };
  jobs: {
    build: {
      strategy: { matrix: { include: MatrixEntry[] } };
      steps: Array<Record<string, unknown>>;
    };
  };
}

// The workflow is plain YAML; the `${{ … }}` expressions load as ordinary strings.
const workflow = yaml.load(readFileSync(WORKFLOW_PATH, 'utf8')) as unknown as Workflow;

// --- a deliberately narrow GitHub Actions expression evaluator ---------------

type Context = Record<string, unknown>;

/**
 * Resolve a dotted context path. GitHub returns the empty string for a path
 * that does not resolve (e.g. `inputs.tag` on a `push` event), rather than
 * failing the expression — so this mirrors that, not a throw.
 */
function lookup(path: string, ctx: Context): string {
  let cur: unknown = ctx;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in (cur as object))) return '';
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined || cur === null ? '' : String(cur);
}

const OPERAND = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(==|!=)\s*'([^']*)'$/;

/** Evaluate an `&&`-joined chain of string comparisons. Throws on anything else. */
function evalBoolean(expr: string, ctx: Context): boolean {
  const trimmed = expr.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.includes('||')) {
    throw new Error(`evalBoolean: unsupported '||' in ${trimmed} — extend the evaluator`);
  }
  return trimmed
    .split('&&')
    .map((operand) => operand.trim())
    .every((operand) => {
      const match = OPERAND.exec(operand);
      if (!match) throw new Error(`evalBoolean: unparseable operand '${operand}'`);
      const [, path, op, literal] = match;
      const actual = lookup(path!, ctx);
      return op === '==' ? actual === literal : actual !== literal;
    });
}

/** Substitute `${{ path }}` / `${{ a || b }}` spans inside a string value. */
function interpolate(raw: string, ctx: Context): string {
  return raw.replace(/\$\{\{([^}]*)\}\}/g, (_full, inner: string) => {
    // `a || b` is GitHub's coalesce: first non-falsy operand wins.
    for (const operand of inner.split('||').map((s) => s.trim())) {
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(operand)) {
        throw new Error(`interpolate: unsupported expression '${operand}'`);
      }
      const value = lookup(operand, ctx);
      if (value !== '') return value;
    }
    return '';
  });
}

/** Split `type=raw,value=x,enable=${{ a && b }}` on commas outside `${{ … }}`. */
function splitAttrs(line: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    if (line.startsWith('${{', i)) {
      depth++;
      buf += '${{';
      i += 2;
      continue;
    }
    if (depth > 0 && line.startsWith('}}', i)) {
      depth--;
      buf += '}}';
      i += 1;
      continue;
    }
    const ch = line[i]!;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

function parseAttrs(line: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const part of splitAttrs(line)) {
    const eq = part.indexOf('=');
    if (eq === -1) throw new Error(`parseAttrs: malformed attribute '${part}' in '${line}'`);
    attrs.set(part.slice(0, eq).trim(), part.slice(eq + 1));
  }
  return attrs;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-.]([0-9A-Za-z.]+))?$/;

/** Expand metadata-action's `{{version}}` / `{{major}}` / `{{minor}}` placeholders. */
function applyPattern(pattern: string, rawVersion: string): string {
  const match = SEMVER.exec(rawVersion);
  if (!match) throw new Error(`applyPattern: '${rawVersion}' is not semver`);
  const [, major, minor, patch, prerelease] = match;
  const version = prerelease ? `${major}.${minor}.${patch}-${prerelease}` : `${major}.${minor}.${patch}`;
  if (prerelease && pattern !== 'v{{version}}') {
    // metadata-action does not let a prerelease claim a stable `{{major}}.{{minor}}`
    // tag. Rather than model that rule, refuse — so adding a prerelease scenario
    // here fails loudly instead of asserting a tag the real action never writes.
    throw new Error(`applyPattern: prerelease '${rawVersion}' with pattern '${pattern}' is not modelled`);
  }
  return pattern.replace(/\{\{(\w+)\}\}/g, (_full, name: string) => {
    switch (name) {
      case 'version':
        return version;
      case 'major':
        return major!;
      case 'minor':
        return minor!;
      case 'patch':
        return patch!;
      default:
        throw new Error(`applyPattern: unsupported placeholder '{{${name}}}'`);
    }
  });
}

/** Render a matrix entry's `tags` block into the tag names it would publish. */
function renderTags(tagsBlock: string, ctx: Context): string[] {
  const published: string[] = [];
  for (const rawLine of tagsBlock.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const attrs = parseAttrs(line);
    const type = attrs.get('type');
    const enable = attrs.get('enable');
    if (enable !== undefined && !evalBoolean(enable.replace(/^\$\{\{|\}\}$/g, ''), ctx)) continue;

    if (type === 'raw') {
      published.push(interpolate(attrs.get('value') ?? '', ctx));
      continue;
    }
    if (type === 'semver') {
      // metadata-action falls back to the git ref when `value` is empty, and
      // only a `refs/tags/*` ref yields a version — a branch ref yields nothing.
      const explicit = interpolate(attrs.get('value') ?? '', ctx);
      const ref = lookup('github.ref', ctx);
      const version = explicit || (ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : '');
      if (version === '') continue;
      published.push(applyPattern(attrs.get('pattern') ?? '', version));
      continue;
    }
    throw new Error(`renderTags: unsupported tag type '${type}' — extend the evaluator`);
  }
  return published;
}

// --- simulated trigger contexts ---------------------------------------------

/**
 * `needs.resolve.outputs.tag` is the workflow's own answer to "what release is
 * being built?" — computed by the `resolve` job from either trigger. Mirrored
 * here so the fixture stays a single source of truth per scenario.
 */
function contextFor(opts: { eventName: string; ref: string; inputTag?: string; releaseTag?: string }): Context {
  const resolvedTag = opts.inputTag || opts.releaseTag || '';
  return {
    github: {
      event_name: opts.eventName,
      ref: opts.ref,
      event: { release: { tag_name: opts.releaseTag ?? '' } },
    },
    inputs: { tag: opts.inputTag ?? '' },
    needs: { resolve: { outputs: { tag: resolvedTag } } },
  };
}

const PUSH_MAIN = contextFor({ eventName: 'push', ref: 'refs/heads/main' });
const RELEASE = contextFor({ eventName: 'release', ref: 'refs/tags/v0.42.0', releaseTag: 'v0.42.0' });
const DISPATCH_WITH_TAG = contextFor({
  eventName: 'workflow_dispatch',
  ref: 'refs/heads/main',
  inputTag: 'v0.40.0',
});
const DISPATCH_BARE = contextFor({ eventName: 'workflow_dispatch', ref: 'refs/heads/main' });

function tagsFor(imageName: string, ctx: Context): string[] {
  const entry = workflow.jobs.build.strategy.matrix.include.find((e) => e.name === imageName);
  if (!entry) throw new Error(`no matrix entry named '${imageName}'`);
  return renderTags(entry.tags, ctx);
}

describe('docker-publish.yml tag derivation', () => {
  describe('push to main (unchanged behaviour)', () => {
    it('publishes only :edge on both images', () => {
      expect(tagsFor('curia', PUSH_MAIN)).toEqual(['edge']);
      expect(tagsFor('curia-postgres', PUSH_MAIN)).toEqual(['edge']);
    });
  });

  describe('release published (unchanged behaviour)', () => {
    it('publishes semver + latest on the app image', () => {
      expect(tagsFor('curia', RELEASE).sort()).toEqual(['latest', 'v0.42', 'v0.42.0']);
    });

    it('publishes pg16 + latest on the DB image', () => {
      expect(tagsFor('curia-postgres', RELEASE).sort()).toEqual(['latest', 'pg16']);
    });

    it('never moves :edge', () => {
      expect(tagsFor('curia', RELEASE)).not.toContain('edge');
      expect(tagsFor('curia-postgres', RELEASE)).not.toContain('edge');
    });
  });

  describe('workflow_dispatch with a tag (the #1715 bug)', () => {
    it('does not touch :edge on either image', () => {
      expect(tagsFor('curia', DISPATCH_WITH_TAG)).not.toContain('edge');
      expect(tagsFor('curia-postgres', DISPATCH_WITH_TAG)).not.toContain('edge');
    });

    it('publishes the requested version as semver tags', () => {
      expect(tagsFor('curia', DISPATCH_WITH_TAG).sort()).toEqual(['v0.40', 'v0.40.0']);
    });

    it('does not move :latest or :pg16 backwards onto the re-published release', () => {
      // These are floating "newest" pointers like :edge. A re-publish is an
      // arbitrary older tag, so only a real `release` event may advance them.
      expect(tagsFor('curia', DISPATCH_WITH_TAG)).not.toContain('latest');
      expect(tagsFor('curia-postgres', DISPATCH_WITH_TAG)).toEqual([]);
    });

    it('checks out the requested tag, and the concurrency group follows it', () => {
      const checkout = workflow.jobs.build.steps[0] as { with: { ref: string } };
      expect(interpolate(checkout.with.ref, DISPATCH_WITH_TAG)).toBe('v0.40.0');
      // Not `refs/heads/main`, or a routine main merge would cancel a rollback.
      expect(interpolate(workflow.concurrency.group, DISPATCH_WITH_TAG)).not.toContain('refs/heads/main');
    });
  });

  describe('workflow_dispatch with no tag (unchanged behaviour)', () => {
    it('still publishes :edge from main', () => {
      expect(tagsFor('curia', DISPATCH_BARE)).toEqual(['edge']);
      expect(tagsFor('curia-postgres', DISPATCH_BARE)).toEqual(['edge']);
    });

    it('checks out the launch ref', () => {
      const checkout = workflow.jobs.build.steps[0] as { with: { ref: string } };
      expect(interpolate(checkout.with.ref, DISPATCH_BARE)).toBe('refs/heads/main');
    });
  });

  describe('provenance', () => {
    it('stamps the revision of the commit actually built, not the launch ref', () => {
      // metadata-action defaults `org.opencontainers.image.revision` to
      // `github.sha`, which on a dispatch is the launch branch's HEAD rather
      // than the checked-out tag. curia-deploy's deploy-time revision assert
      // trusts this label, so a wrong value makes that check fail *open*.
      const steps = workflow.jobs.build.steps;
      const resolvesSha = steps.some((step) => /git rev-parse HEAD/.test(String(step.run ?? '')));
      expect(resolvesSha).toBe(true);

      const meta = steps.find((step) => step.id === 'meta') as { with: { labels?: string } };
      expect(meta.with.labels ?? '').toContain('org.opencontainers.image.revision=');
    });
  });
});
