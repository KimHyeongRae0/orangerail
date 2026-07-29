/**
 * scripts/check-published-artifact.mjs
 *
 * Post-build gate over what actually reaches npm. It runs from the root `build`
 * script, so verify.sh's build gate (9/9) and CI both cover it, and it inspects
 * the built `dist/` trees rather than the source they came from.
 *
 * Two rules, both closing a class of defect that is invisible in `src/`:
 *
 *   PUB-01  A Node-consumable bundle must not carry a BARE builtin specifier.
 *           Source uses `node:` prefixes throughout, but tsup's
 *           `removeNodeProtocol` (default: true) rewrote them to `fs`,
 *           `readline/promises` and friends. Two things go wrong then: a bare
 *           name is resolved against node_modules first, so any package of that
 *           name shadows the builtin; and on a runtime where the bare builtin
 *           does not exist the loader answers `Cannot find package 'readline'`,
 *           sending the user of a supply-chain-sensitive tool to an abandoned
 *           third-party package. 0.1.0 shipped with exactly that (ONT-047).
 *
 *   PUB-02  Every publishable package declares `engines.node`. Without it npm
 *           installs silently onto a runtime the code cannot load, and the user
 *           learns the floor from a stack trace instead of from the install.
 *
 * Usage: node scripts/check-published-artifact.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const RED = '[0;31m';
const GREEN = '[0;32m';
const BOLD = '[1m';
const NC = '[0m';

/** Bundles only the browser loads are exempt: no Node loader ever resolves them. */
const BROWSER_DIRS = [join('dist', 'app')];

/** Only executable output is scanned; `.map` files embed the original sources. */
const CODE_EXTENSIONS = ['.js', '.cjs', '.mjs'];

/**
 * Every builtin name and documented subpath, longest first so the alternation
 * prefers `readline/promises` over `readline`.
 */
const BARE_BUILTINS = builtinModules
  .filter((name) => !name.startsWith('node:') && !name.startsWith('_'))
  .sort((a, b) => b.length - a.length);

/**
 * `from "fs"`, `require("fs")`, `import("fs")` — the three forms a bundler emits
 * for a specifier it did not inline. A `node:`-prefixed specifier cannot match:
 * the alternation is anchored to the opening quote.
 */
const BARE_SPECIFIER = new RegExp(
  String.raw`(?:from|require\s*\(|import\s*\()\s*(['"])(${BARE_BUILTINS.join('|')})\1`,
  'g',
);

const listFiles = ({ dir }) => {
  let entries;

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);

    return entry.isDirectory() ? listFiles({ dir: path }) : [path];
  });
};

const packageDirs = () =>
  readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ROOT, 'packages', entry.name))
    .filter((dir) => {
      try {
        return statSync(join(dir, 'package.json')).isFile();
      } catch {
        return false;
      }
    })
    .sort();

const problems = [];
let scannedFiles = 0;
let checkedPackages = 0;

for (const dir of packageDirs()) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

  if (manifest.private === true) {
    continue;
  }

  checkedPackages += 1;

  // ---- PUB-02: engines.node ----
  if (typeof manifest.engines?.node !== 'string' || manifest.engines.node.trim() === '') {
    problems.push(
      `PUB-02: ${manifest.name} (${relative(ROOT, dir)}/package.json) declares no engines.node — ` +
        `npm cannot warn anyone installing it onto an unsupported runtime`,
    );
  }

  // ---- PUB-01: bare builtin specifiers in the built output ----
  for (const file of listFiles({ dir: join(dir, 'dist') })) {
    const rel = relative(dir, file);

    if (
      !CODE_EXTENSIONS.some((ext) => rel.endsWith(ext)) ||
      BROWSER_DIRS.some((browserDir) => rel.startsWith(`${browserDir}${sep}`))
    ) {
      continue;
    }

    scannedFiles += 1;

    const hits = new Set();

    for (const match of readFileSync(file, 'utf8').matchAll(BARE_SPECIFIER)) {
      hits.add(match[2]);
    }

    for (const hit of [...hits].sort()) {
      problems.push(
        `PUB-01: ${manifest.name} — ${relative(ROOT, file)} imports the builtin "${hit}" without ` +
          `the node: prefix (set removeNodeProtocol: false in its tsup config)`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`${RED}  x ${problem}${NC}\n`);
  }

  process.stderr.write(
    `\n${BOLD}${RED}========== PUBLISHED-ARTIFACT BLOCK (${problems.length}) ==========${NC}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${GREEN}OK published-artifact — ${checkedPackages} package(s), ${scannedFiles} built file(s): ` +
    `node: prefixes intact, engines.node declared${NC}\n`,
);
