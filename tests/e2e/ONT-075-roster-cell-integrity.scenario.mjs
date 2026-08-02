/**
 * ONT-075 e2e driver — the ANALYTICS.md roster keeps its columns (ticket section 5).
 *
 * Drives the SHIPPED CLI (packages/cli/dist/main.js) exactly as an operator
 * would, over two Jira exports and nothing else:
 *
 *   1. hostile export — a display name carrying `|`, a display name carrying
 *      CRLF, and a story-point total that overflows to `Infinity`. Every roster
 *      row must have exactly as many cells as the header, every name must
 *      survive whole, every metric must be the value the export implies, and
 *      the overflow must be NAMED in ONT-071's vocabulary rather than printed.
 *   2. conforming export — the emitted ANALYTICS.md must be byte-identical to
 *      the reference the merge-base binary produced (fixtures/ont-075/reference).
 *
 * The table is read the way a markdown renderer reads it — rows split on
 * newlines, cells split on UNESCAPED pipes — because that is the only view the
 * reader of ANALYTICS.md ever gets. Counting raw `|` characters would call a
 * row well-formed that a renderer tears into two.
 *
 * RED (pre-implementation) on `062e527`, phase 1:
 *   | acc_a | Ann | 9 | 999 | yes | yes | 1 | 5 | 1/0/0 | n/a | n/a/n/a | n/a | n/a | 0 | 3/0 |
 *   -> 15 cells for a 12-column table; the rendered row reads 999 tickets and
 *      `yes` story points for a person with 1 ticket and 5 points, and the CRLF
 *      name blanks every metric acc_c has while a nameless row below carries them.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures', 'ont-075');
const SCRATCH = join(ROOT, '.docs', 'scratch', 'ont-075');

/** The marker `render.ts:102` writes, spelled out so a change to it fails here. */
const MARKER_PREFIX = '<UNRENDERABLE — ';

const fail = ({ message }) => {
  console.error(`ONT-075 e2e FAIL: ${message}`);
  process.exit(1);
};

const assert = ({ ok, message }) => {
  if (!ok) {
    fail({ message });
  }
};

/** Run the shipped `init` in a fresh directory and return what it wrote. */
const runInit = ({ name, exportFile }) => {
  const cwd = join(SCRATCH, name);

  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });

  const res = spawnSync('node', [CLI, 'init', '--from-jira', join(FIXTURES, exportFile)], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });

  return { cwd, status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/**
 * One markdown table row as a renderer sees it: split on pipes that are NOT
 * escaped (GFM's one escape inside a table cell), leading and trailing delimiter
 * dropped, each cell unescaped back to the text a reader is shown.
 */
const cellsOf = ({ line }) =>
  line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));

/**
 * The roster block of an emitted report, as rows of rendered cells.
 *
 * The block ends at the first line a renderer would not attach to the table —
 * which is exactly how a name carrying a line break truncates it, so the block
 * is cut on that rule rather than on a row count we expect to see.
 */
const roster = ({ cwd }) => {
  const report = readFileSync(join(cwd, 'ANALYTICS.md'), 'utf8');
  const lines = report.split('\n');
  const start = lines.findIndex((line) => line.startsWith('| accountId'));

  assert({ ok: start >= 0, message: 'no roster header in ANALYTICS.md' });

  let end = start + 1;
  while (end < lines.length && lines[end].startsWith('|')) {
    end += 1;
  }

  const block = lines.slice(start, end);

  return {
    report,
    block,
    text: block.join('\n'),
    rows: block.slice(2).map((line) => cellsOf({ line })),
  };
};

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

// ---- phase 1: the hostile export -------------------------------------------

const hostile = runInit({ name: 'hostile', exportFile: 'jira-hostile.json' });

assert({
  ok: hostile.status === 0,
  message: `phase 1: init exited ${hostile.status}\n${hostile.stderr}`,
});

const hostileRoster = roster({ cwd: hostile.cwd });
const columns = cellsOf({ line: hostileRoster.block[0] }).length;
const rows = hostileRoster.rows;

assert({
  ok: rows.length === 4,
  message:
    `phase 1: the table carries ${rows.length} body rows, the export has 4 people\n` +
    hostileRoster.block.map((line) => `  ${JSON.stringify(line)}`).join('\n'),
});

for (const row of rows) {
  assert({
    ok: row.length === columns,
    message: `phase 1: a row has ${row.length} cells, the header has ${columns}: ${JSON.stringify(row)}`,
  });
}

/** accountId -> the rendered cells of that person's row. */
const byAccount = new Map(rows.map((row) => [row[0], row]));

const expected = [
  // A name is a name: the pipes are escaped, never spread across the columns,
  // and never replaced by a marker — the person really is called this.
  ['acc_a', ['acc_a', 'Ann | 9 | 999 | yes', 'yes', '1', '5', '1/0/0']],
  // Two story points that each pass the scanner's finite guard, summing past it.
  ['acc_b', ['acc_b', 'Bea B', 'yes', '2', `${MARKER_PREFIX}the number Infinity>`, '2/0/0']],
  // A name that used to end the table row it sat in.
  ['acc_c', ['acc_c', 'Cy Collins', 'yes', '1', '2', '0/0/1']],
  // The control: an ordinary row, unchanged by any of this.
  ['acc_d', ['acc_d', 'Dee Dawson', 'yes', '1', '3', '0/1/0']],
];

for (const [accountId, head] of expected) {
  const row = byAccount.get(accountId);

  assert({ ok: row !== undefined, message: `phase 1: ${accountId} is not in the rendered table` });

  for (const [index, cell] of head.entries()) {
    assert({
      ok: row[index] === cell,
      message: `phase 1: ${accountId} cell ${index} is ${JSON.stringify(row[index])}, expected ${JSON.stringify(cell)}`,
    });
  }
}

assert({
  ok: !hostileRoster.text.includes('| Infinity |'),
  message: 'phase 1: the roster still prints a bare Infinity',
});

// ---- phase 2: the conforming export is byte-identical -----------------------

const conforming = runInit({ name: 'conforming', exportFile: 'jira-conforming.json' });

assert({
  ok: conforming.status === 0,
  message: `phase 2: init exited ${conforming.status}\n${conforming.stderr}`,
});

const produced = readFileSync(join(conforming.cwd, 'ANALYTICS.md'), 'utf8');
const reference = readFileSync(join(FIXTURES, 'reference', 'ANALYTICS.md'), 'utf8');

if (produced !== reference) {
  const producedLines = produced.split('\n');
  const differing = reference
    .split('\n')
    .map((line, index) => (line === producedLines[index] ? null : index))
    .filter((index) => index !== null)
    .slice(0, 5);

  fail({
    message:
      `phase 2: ANALYTICS.md is not byte-identical to the merge-base reference.\n` +
      differing
        .map(
          (index) =>
            `  line ${index + 1}\n    reference: ${JSON.stringify(reference.split('\n')[index])}\n    produced:  ${JSON.stringify(producedLines[index])}`,
        )
        .join('\n'),
  });
}

console.log('ONT-075 e2e: 2/2 phases passed');
console.log(`  phase 1: ${rows.length} rows, ${columns} cells each, over the hostile export`);
console.log(
  `  phase 2: ANALYTICS.md byte-identical to the merge-base reference (${reference.length} bytes)`,
);
