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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const WORKFLOW_PATH = join(import.meta.dirname, '../../../.github/workflows/docker-publish.yml');

interface MatrixEntry {
  name: string;
  image: string;
  dockerfile: string;
  tags: string;
}

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Workflow {
  concurrency: { group: string };
  jobs: {
    resolve: { steps: Step[] };
    build: {
      strategy: { matrix: { include: MatrixEntry[] } };
      steps: Array<Record<string, unknown>>;
    };
  };
}

const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');

/**
 * Check the shape we depend on before asserting the type, so a restructured
 * workflow fails here with a sentence about what is missing rather than ten
 * lines down on `Cannot read properties of undefined`.
 */
function assertWorkflowShape(doc: unknown): asserts doc is Workflow {
  const problems: string[] = [];
  const root = doc as Partial<Workflow> | null;
  if (typeof root !== 'object' || root === null) throw new Error('workflow did not parse to an object');
  if (typeof root.concurrency?.group !== 'string') problems.push('concurrency.group');
  const build = root.jobs?.build;
  if (!build) problems.push('jobs.build');
  if (!Array.isArray(build?.steps) || build.steps.length === 0) problems.push('jobs.build.steps');
  const resolveSteps = root.jobs?.resolve?.steps;
  if (!Array.isArray(resolveSteps) || !resolveSteps.some((s) => typeof s?.run === 'string')) {
    problems.push('jobs.resolve.steps (needs a step with a `run` block)');
  }
  const include = build?.strategy?.matrix?.include;
  if (!Array.isArray(include) || include.length === 0) {
    problems.push('jobs.build.strategy.matrix.include');
  } else {
    for (const entry of include) {
      if (typeof entry?.name !== 'string' || typeof entry?.tags !== 'string') {
        problems.push(`matrix entry ${JSON.stringify(entry?.name)} (needs name + tags)`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`docker-publish.yml is missing or has restructured: ${problems.join(', ')}`);
  }
}

// The workflow is plain YAML; the `${{ … }}` expressions load as ordinary strings.
const parsed: unknown = yaml.load(WORKFLOW_SOURCE);
// Cast only after the runtime check above.
assertWorkflowShape(parsed);
const workflow: Workflow = parsed;

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

/**
 * GitHub's ternary idiom: `<condition> && '<then>' || '<else>'`. Both branches
 * must be string literals — modelling an arbitrary expression there would mean
 * a general evaluator, and this file's whole premise is that it refuses what it
 * does not understand.
 */
const TERNARY = /^(.+?)\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'$/;

/** Substitute `${{ path }}` / `${{ a || b }}` / ternary spans in a string value. */
function interpolate(raw: string, ctx: Context): string {
  return raw.replace(/\$\{\{([^}]*)\}\}/g, (_full, inner: string) => {
    const ternary = TERNARY.exec(inner.trim());
    if (ternary) {
      const [, condition, whenTrue, whenFalse] = ternary;
      return evalBoolean(condition!, ctx) ? whenTrue! : whenFalse!;
    }
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
 *
 * The precedence must match the shell in `resolve`: dispatch input, then the
 * release event's tag, then a `refs/tags/*` launch ref. That last one is the
 * ref-dropdown dispatch form (#1718), and it is the only case where
 * `github.ref` legitimately names the build target rather than the launch site.
 */
function contextFor(opts: { eventName: string; ref: string; inputTag?: string; releaseTag?: string }): Context {
  const refTag = opts.ref.startsWith('refs/tags/') ? opts.ref.slice('refs/tags/'.length) : '';
  const resolvedTag = opts.inputTag || opts.releaseTag || refTag;
  return {
    github: {
      event_name: opts.eventName,
      ref: opts.ref,
      // `ref_name` is `ref` with its `refs/heads/` or `refs/tags/` prefix
      // stripped. Deliberately unread today — the concurrency group keys on
      // `github.ref`, because `ref_name` would flatten branches, tags and
      // inputs into one string space (see "keeps a tag-shaped input away from
      // the branch it names"). It stays in the fixture because `lookup` fails
      // soft: an expression that started reading `github.ref_name` would
      // otherwise render as `''` here and quietly assert nonsense. Derived
      // rather than passed in so a fixture cannot state a ref and a ref_name
      // that disagree.
      ref_name: opts.ref.replace(/^refs\/(heads|tags)\//, ''),
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
const DISPATCH_BARE_OFF_MAIN = contextFor({
  eventName: 'workflow_dispatch',
  ref: 'refs/heads/some-feature',
});
/** The other dispatch form: the tag picked in "Use workflow from", input empty. */
const DISPATCH_FROM_TAG_REF = contextFor({
  eventName: 'workflow_dispatch',
  ref: 'refs/tags/v0.40.0',
});

/**
 * The `resolve` job's tag guard, lifted from the workflow itself rather than
 * copied — a test that restates the pattern would pass against its own copy
 * while the real one drifted. The grammar uses only constructs that mean the
 * same thing in POSIX ERE and JS (no lookaround, no `\d`, trailing `-` inside
 * the bracket expressions), so `grep -E` and `RegExp` agree.
 */
function tagGuardPattern(): RegExp {
  const match = /grep -Eq '(\^v[^']*)'/.exec(WORKFLOW_SOURCE);
  if (!match) throw new Error('could not find the tag-validation grep in the resolve job');
  return new RegExp(match[1]!);
}

/**
 * Locate the checkout step by what it *is*, not where it sits — a new setup
 * step inserted above it should not fail these tests for ordering.
 */
function checkoutRef(): string {
  const checkout = workflow.jobs.build.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/checkout@'),
  ) as { with?: { ref?: string } } | undefined;
  if (typeof checkout?.with?.ref !== 'string') {
    throw new Error('no actions/checkout step with a `ref` in jobs.build.steps');
  }
  return checkout.with.ref;
}

// --- running the real `resolve` script ---------------------------------------

/**
 * The rest of this file *models* the workflow. That model now has a second
 * source of truth to stay in sync with — `contextFor` mirrors the precedence
 * rules inside the `resolve` job's shell — and a mirror that drifts is worse
 * than no test, because it stays green while describing a workflow that no
 * longer exists.
 *
 * So run the actual script. Its `env:` block is interpolated against the same
 * simulated context the tag assertions use, giving one end-to-end path:
 * trigger context -> env vars -> the real shell -> the resolved target. Anyone
 * editing the precedence in the YAML and not here gets a red test.
 *
 * `bash -e` matches the default shell GitHub Actions runs a `run:` block under.
 */
function runResolve(ctx: Context): { status: number; wrote: boolean; tag: string; output: string } {
  // By id, not by position — the same principle `checkoutRef` states above. A
  // setup step with its own `run:` inserted ahead of this one would otherwise
  // silently redirect the whole suite onto the wrong script, with the wrong
  // `env:` block interpolated alongside it.
  const step = workflow.jobs.resolve.steps.find((s) => s.id === 'resolve' && typeof s.run === 'string');
  if (!step) throw new Error("no `run` step with id 'resolve' in jobs.resolve.steps");

  const dir = mkdtempSync(join(tmpdir(), 'docker-publish-resolve-'));
  try {
    const scriptPath = join(dir, 'resolve.sh');
    const outputPath = join(dir, 'github_output');
    writeFileSync(scriptPath, step.run!);
    writeFileSync(outputPath, '');

    // Only the variables the step declares, plus GITHUB_OUTPUT. Inheriting the
    // ambient environment would let a stray INPUT_TAG on a developer's machine
    // change the result.
    //
    // Note this models `step.env` only — a future edit reading a workflow- or
    // job-level `env` var would be exercised here as unset while the real
    // runner has it set. Extend this if the resolve script ever needs one.
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: outputPath };
    for (const [name, expr] of Object.entries(step.env ?? {})) {
      env[name] = interpolate(String(expr), ctx);
    }

    let status = 0;
    let output = '';
    try {
      // The workflow writes both `::error::` and `::notice::` to stdout, so
      // capture it on the success path too — those annotations are the run
      // summary's only account of what got published, and are asserted below.
      output = execFileSync('bash', ['-e', scriptPath], { env, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      const failure = err as { status?: number; stdout?: string; stderr?: string };
      // `execFileSync` also throws when bash cannot be spawned, on maxBuffer
      // overflow, and on death by signal — in all of which `status` is absent.
      // Coercing those to 1 would let a broken harness masquerade as the script
      // correctly refusing, quietly passing every negative test below.
      if (typeof failure.status !== 'number') throw err;
      status = failure.status;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    // Last write wins, matching the runner's GITHUB_OUTPUT semantics — a script
    // that wrote a default and then overrode it would otherwise be read here as
    // the opposite of what really runs. `wrote` keeps "never written" separate
    // from "written empty", which an `?? ''` fallback would collapse.
    const written = [...readFileSync(outputPath, 'utf8').matchAll(/^tag=(.*)$/gm)];
    return { status, wrote: written.length > 0, tag: written.at(-1)?.[1] ?? '', output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
      expect(interpolate(checkoutRef(), DISPATCH_WITH_TAG)).toBe('v0.40.0');
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
      expect(interpolate(checkoutRef(), DISPATCH_BARE)).toBe('refs/heads/main');
    });
  });

  describe('bare workflow_dispatch from a branch other than main', () => {
    // `edge` means "the newest main", so this must never mint one from unmerged
    // code — and it does not. But there is also nothing else it could publish,
    // so as of #1718 `resolve` refuses the run outright (asserted below in
    // "the resolve job, executed"). It used to be green with a skip notice per
    // image, which is a publish workflow reporting success having published
    // nothing: the #1715 failure mode wearing a different hat.
    it('would publish nothing, on both images', () => {
      expect(tagsFor('curia', DISPATCH_BARE_OFF_MAIN)).toEqual([]);
      expect(tagsFor('curia-postgres', DISPATCH_BARE_OFF_MAIN)).toEqual([]);
    });

    it('never mints an edge tag from a non-main branch', () => {
      expect(tagsFor('curia', DISPATCH_BARE_OFF_MAIN)).not.toContain('edge');
      expect(tagsFor('curia-postgres', DISPATCH_BARE_OFF_MAIN)).not.toContain('edge');
    });
  });

  describe('workflow_dispatch from the ref dropdown (#1718)', () => {
    // The second way to re-publish: pick the tag in "Use workflow from" and
    // leave the `tag` input empty. It has to reach the same place as the input
    // form, or the workflow has two behaviours and its documentation can only
    // describe one of them.
    it('publishes the same tags as the input form', () => {
      expect(tagsFor('curia', DISPATCH_FROM_TAG_REF).sort()).toEqual(
        tagsFor('curia', DISPATCH_WITH_TAG).sort(),
      );
      expect(tagsFor('curia-postgres', DISPATCH_FROM_TAG_REF)).toEqual(
        tagsFor('curia-postgres', DISPATCH_WITH_TAG),
      );
    });

    it('publishes that release semver and nothing floating', () => {
      expect(tagsFor('curia', DISPATCH_FROM_TAG_REF).sort()).toEqual(['v0.40', 'v0.40.0']);
      expect(tagsFor('curia', DISPATCH_FROM_TAG_REF)).not.toContain('edge');
      expect(tagsFor('curia', DISPATCH_FROM_TAG_REF)).not.toContain('latest');
      expect(tagsFor('curia-postgres', DISPATCH_FROM_TAG_REF)).toEqual([]);
    });

    it('checks out the tag', () => {
      expect(interpolate(checkoutRef(), DISPATCH_FROM_TAG_REF)).toBe('v0.40.0');
    });
  });

  describe('concurrency grouping', () => {
    const groupFor = (ctx: Context) => interpolate(workflow.concurrency.group, ctx);

    it('isolates a release from a re-publish of the very same tag', () => {
      // The asymmetry that makes this matter: a release publishes semver +
      // `latest` + `pg16`; a re-publish of that tag publishes semver only. With
      // `cancel-in-progress`, sharing a group means an impatient re-publish
      // ("is the release build stuck?") cancels the release and strands
      // `latest` and `pg16` on the previous version. Nothing would report it:
      // `notify-failure` gates on failure and excludes cancellation.
      const releaseOfSameTag = contextFor({
        eventName: 'release',
        ref: 'refs/tags/v0.40.0',
        releaseTag: 'v0.40.0',
      });
      expect(groupFor(releaseOfSameTag)).not.toBe(groupFor(DISPATCH_WITH_TAG));
      expect(groupFor(releaseOfSameTag)).not.toBe(groupFor(DISPATCH_FROM_TAG_REF));
    });

    it('collapses a push to main with a bare dispatch from main', () => {
      // Both write exactly `:edge`, so the newer one superseding the older is
      // the intended behaviour rather than a lost publish.
      expect(groupFor(DISPATCH_BARE)).toBe(groupFor(PUSH_MAIN));
    });

    it('keeps a tag-shaped input away from the branch it names', () => {
      // Groups are evaluated at queue time, before `resolve` can reject
      // anything. So `tag: main` — a plausible misreading of the input box —
      // must not land in main's group and cancel an in-flight `edge` build on
      // its way to being refused. This is why the group is not normalised with
      // `github.ref_name`, which would flatten branches, tags and inputs into
      // one string space.
      const typo = contextFor({ eventName: 'workflow_dispatch', ref: 'refs/heads/main', inputTag: 'main' });
      expect(groupFor(typo)).not.toBe(groupFor(PUSH_MAIN));
    });
  });

  describe('the resolve job, executed', () => {
    // These run the workflow's own shell rather than the model of it above.
    it.each([
      ['push to main', PUSH_MAIN, ''],
      ['a release', RELEASE, 'v0.42.0'],
      ['a dispatch with a tag input', DISPATCH_WITH_TAG, 'v0.40.0'],
      ['a dispatch from a tag ref', DISPATCH_FROM_TAG_REF, 'v0.40.0'],
      ['a bare dispatch from main', DISPATCH_BARE, ''],
    ])('resolves %s to %o', (_name, ctx, expected) => {
      const result = runResolve(ctx as Context);
      expect(result.status).toBe(0);
      expect(result.wrote).toBe(true);
      expect(result.tag).toBe(expected);
      // The fixtures feed the tag assertions above; if the real script and the
      // fixture disagree, every other test in this file is measuring fiction.
      expect(result.tag).toBe(lookup('needs.resolve.outputs.tag', ctx as Context));
    });

    it.each([
      ['a tag build', DISPATCH_WITH_TAG, '::notice::Publish target: release v0.40.0'],
      ['an edge build', PUSH_MAIN, '::notice::Publish target: main'],
    ])('announces %s on the run summary', (_name, ctx, expected) => {
      // The notices are the run summary's only account of what was published.
      // Without this they could be deleted, or inverted to report a tag build
      // as an edge build, with every other test still green.
      expect(runResolve(ctx as Context).output).toContain(expected);
    });

    it('accepts both boxes filled when they name the same tag', () => {
      const agreeing = contextFor({
        eventName: 'workflow_dispatch',
        ref: 'refs/tags/v0.40.0',
        inputTag: 'v0.40.0',
      });
      expect(runResolve(agreeing)).toMatchObject({ status: 0, wrote: true, tag: 'v0.40.0' });
    });

    it('refuses a dispatch whose tag input and launch ref disagree', () => {
      // Ambiguous, and the two boxes have different consequences: the input
      // decides what is built, the dropdown decides which workflow file runs.
      const conflicting = contextFor({
        eventName: 'workflow_dispatch',
        ref: 'refs/tags/v0.41.0',
        inputTag: 'v0.40.0',
      });
      const result = runResolve(conflicting);
      expect(result.status).not.toBe(0);
      expect(result.wrote).toBe(false);
      expect(result.output).toContain("::error::Tag input 'v0.40.0' was dispatched from 'refs/tags/v0.41.0'");
    });

    it('refuses a tag re-publish launched from an unrelated branch', () => {
      // Resolves to the right *target*, but would run that branch's copy of the
      // workflow — and the branch most likely to be selected here is one
      // editing this very file. A real release image built from unreviewed YAML.
      const offMain = contextFor({
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/some-feature',
        inputTag: 'v0.40.0',
      });
      const result = runResolve(offMain);
      expect(result.status).not.toBe(0);
      expect(result.wrote).toBe(false);
      expect(result.output).toContain('::error::');
    });

    it('refuses a bare dispatch that could publish nothing', () => {
      // There is no tag and `edge` may only ever mean main, so this run has
      // nothing it could write. It used to be green with a skip notice per
      // image — a publish workflow reporting success having published nothing.
      const result = runResolve(DISPATCH_BARE_OFF_MAIN);
      expect(result.status).not.toBe(0);
      expect(result.wrote).toBe(false);
      expect(result.output).toContain('::error::Nothing to publish');
    });

    it('refuses a malformed tag before anything is built', () => {
      const bad = contextFor({
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/main',
        inputTag: 'v1.2.3.4',
      });
      const result = runResolve(bad);
      expect(result.status).not.toBe(0);
      expect(result.wrote).toBe(false);
      // Naming the offending value and where it came from is the point: this is
      // reachable from the ref dropdown, where the operator typed nothing.
      expect(result.output).toContain("::error::Refusing to build: 'v1.2.3.4' (from the tag input)");
    });

    it('refuses a multi-line tag rather than validating only its first line', () => {
      // `grep` asks "does any line match", so `v1.2.3\nfoo` passed the SemVer
      // guard on its first line and wrote two lines into GITHUB_OUTPUT — where
      // the runner reads the *last* one as the output, unvalidated.
      const sneaky = contextFor({
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/main',
        inputTag: 'v1.2.3\nnot-a-version',
      });
      const result = runResolve(sneaky);
      expect(result.status).not.toBe(0);
      expect(result.wrote).toBe(false);
      expect(result.output).toContain('::error::Refusing to build: the publish target spans multiple lines.');
    });

    it('refuses a malformed tag arriving via the ref dropdown', () => {
      // Before #1718 this path bypassed the guard entirely: `resolve` saw no
      // tag, and metadata-action silently dropped the unparseable semver entry,
      // leaving a green run that published nothing.
      const bad = contextFor({ eventName: 'workflow_dispatch', ref: 'refs/tags/nightly-2026-09-02' });
      const result = runResolve(bad);
      expect(result.wrote).toBe(false);
      expect(result.output).toContain('(from the launch ref refs/tags/nightly-2026-09-02)');
      expect(result.status).not.toBe(0);
      expect(result.tag).toBe('');
    });
  });

  describe('the resolve job tag guard', () => {
    // A loose guard is not a harmless typo check. metadata-action silently skips
    // a `type=semver` entry it cannot parse, while `latest` is keyed to the
    // event rather than to the version — so a tag that looks version-ish but is
    // not SemVer would advance `latest` onto a build with no version tag.
    it.each(['v1.2.3', 'v0.43.0', 'v1.0.0', 'v1.2.3-rc.1', 'v1.2.3-beta', 'v10.20.30'])(
      'accepts %s',
      (tag) => {
        expect(tagGuardPattern().test(tag)).toBe(true);
      },
    );

    it.each([
      'v1.2.3.4', // four components — not SemVer
      'v1.2.3-rc..1', // empty prerelease identifier
      'v01.2.3', // leading zero
      'v1.2.3+build.1', // build metadata; `+` is not a legal Docker tag character
      'v1.2', // missing patch
      '1.2.3', // missing the `v`
      'v1.2.3-', // empty prerelease
      'v1.2.3 ; rm -rf /', // shell metacharacters
    ])('rejects %s', (tag) => {
      expect(tagGuardPattern().test(tag)).toBe(false);
    });

    it('matches what the app image will actually publish for an accepted tag', () => {
      expect(tagGuardPattern().test('v0.40.0')).toBe(true);
      expect(tagsFor('curia', DISPATCH_WITH_TAG).sort()).toEqual(['v0.40', 'v0.40.0']);
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
