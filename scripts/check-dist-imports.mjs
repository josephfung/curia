#!/usr/bin/env node
// check-dist-imports.mjs — fail when the built bundle imports a name a package
// does not export under Node's own ESM loader.
//
// A CommonJS package (web-push, for one) often exposes its functions only on the
// default export. `import { fn } from 'pkg'` then passes typecheck and vitest,
// whose interop is lenient, but the built app fails to link at startup
// (#2410: production crash-looped on web-push). This loads every package that
// dist/index.js imports by name or by default, using plain Node, and checks
// each binding exists.
//
// Run it with plain `node`, never tsx: tsx's interop would hide the problem.
//
// usage: node scripts/check-dist-imports.mjs [path/to/bundle.js]

import { readFileSync } from 'node:fs';
import path from 'node:path';

const bundle = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../dist/index.js'));

let source;
try {
  source = readFileSync(bundle, 'utf8');
} catch (err) {
  console.error(`check-dist-imports: cannot read ${bundle} (run \`pnpm run build\` first): ${err.message}`);
  process.exit(2);
}

// Static forms that bind names from a package, each checked under Node:
//   import X from "p"            import { a, b as c } from "p"
//   import X, { a } from "p"     import X, * as ns from "p"   (needs a default)
//   export { a, b as c } from "p"   (a re-export also links at startup)
// Namespace-only imports, `export * from "p"` and side-effect imports cannot
// fail this way. Dynamic import() is resolved at runtime and is not checked.
const IMPORT_RE = /^import\s+([\w$]+)?\s*,?\s*(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)?\s*from\s*["']([^"']+)["'];?/gm;
const REEXPORT_RE = /^export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?/gm;

/** @type {Map<string, { needsDefault: boolean, names: Set<string> }>} */
const wanted = new Map();

/** Record what `specifier` must provide: a default, and the names before any `as`. */
function want(specifier, defaultName, namedList) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return;
  if (!defaultName && !namedList) return;
  const entry = wanted.get(specifier) ?? { needsDefault: false, names: new Set() };
  if (defaultName) entry.needsDefault = true;
  for (const part of (namedList ?? '').split(',')) {
    const name = part.trim().split(/\s+as\s+/)[0]?.trim();
    if (name && name !== 'default') entry.names.add(name);
    if (name === 'default') entry.needsDefault = true;
  }
  wanted.set(specifier, entry);
}

for (const [, defaultName, namedList, specifier] of source.matchAll(IMPORT_RE)) {
  want(specifier, defaultName, namedList);
}
for (const [, namedList, specifier] of source.matchAll(REEXPORT_RE)) {
  want(specifier, undefined, namedList);
}

const problems = [];
let bindings = 0;
for (const [specifier, { needsDefault, names }] of wanted) {
  let mod;
  try {
    mod = await import(specifier);
  } catch (err) {
    problems.push(`${specifier}: could not be loaded: ${String(err.message).split('\n')[0]}`);
    continue;
  }
  if (needsDefault) {
    bindings += 1;
    if (!('default' in mod)) problems.push(`${specifier}: no default export`);
  }
  for (const name of names) {
    bindings += 1;
    if (!(name in mod)) {
      const onDefault = mod.default && typeof mod.default === 'object' && name in mod.default;
      problems.push(
        `${specifier}: no named export "${name}"`
          + (onDefault ? ' (it is on the default export: this is a CommonJS package, so import its default)' : ''),
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`check-dist-imports: ${problems.length} import(s) in ${path.relative(process.cwd(), bundle)} would fail at startup:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`check-dist-imports: ${bindings} bindings from ${wanted.size} packages resolve under Node ESM.`);
