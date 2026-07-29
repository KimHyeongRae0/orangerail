# Changelog

All five packages — `orangerail`, `orangerail-core`, `orangerail-mcp`,
`orangerail-docs-gen` and `orangerail-studio` — are versioned and released
together, so one entry covers all of them.

This is a v0 project: the API is the design target and it will move before 1.0.
Anything that changes what an existing project does on upgrade is called out
under **Upgrading** rather than buried in a list.

## Unreleased

The first release after `0.1.0`. Everything below is merged on `main`.

### Upgrading from 0.1.0

**An approval that was still `pending` when you upgrade must be re-staged.**
`createApproval` now stamps an `inputHash` over the approved payload, and
`execute` recomputes it before running anything. A record written by `0.1.0`
carries no such hash, so `execute` cannot bind the payload to the approval it is
about to act on and **refuses**: the approval is consumed and the call returns
`{ status: 'invalidated', reason: 'input' }`, with an `invalidated` record on the
audit chain. Nothing runs on an unverifiable payload. Ask the agent to call the
tool again and approve the fresh approval.

Nothing else about an existing store changes:

- **Your audit chain still verifies, bit for bit.** No record shape changed and
  no hash input changed, so `orangerail audit verify` reads a `0.1.0` chain
  exactly as it did before.
- **A missing `inputHash` is not reported as tampering.** Verification cannot
  distinguish a `0.1.0` record from one whose hash was stripped, and accusing
  every pre-upgrade approval of tampering would be worse than useless. The swap
  that hash exists to catch is still caught from the chain side, by comparing the
  input on the `staged`/`approved` records against the input on the
  `execution_started`/`succeeded` ones — which needs no hash and therefore works
  on records written before the hash existed.

**Your first `orangerail sync` will exit 1, once.** A project with at least one
action and no `orangerail.governance.json` reports `governance: no recorded
baseline` and exits 1 until you run `orangerail sync --accept-governance` one
time and commit the file it writes. This is deliberate: the alternative — warn
and exit 0 — means deleting the baseline buys silence, which is the whole thing
the check exists to prevent. A project with zero actions has no posture to vouch
for and stays green.

**A `sandbox` server no longer completes approvals.** If you were running one
against a store shared with a live server, it was executing real approvals; it
now records a `dry_run` and leaves the approval `approved` for the live engine to
complete. See Security below.

### Security

- **`execute` binds the approved payload.** `signatureHash` only ever covered an
  action's *declared* shape, so an input edited in the store between approval and
  execution ran unchallenged — an operator could approve `harmless-test-widget`
  and the engine delete `PRODUCTION-CUSTOMER-TABLE`. `createApproval` now stamps
  `inputHash` and `execute` re-checks it before any side effect.
- **The approvals store and the audit chain are cross-checked against each
  other.** Eleven checks, run by `verifyAudit` wherever the two logs overlap:
  executed with no `approved` record, decided with no `staged` record, a replayed
  execution, records disagreeing on the action, input changed between the
  approved and the executed records, store status against chain decision in both
  directions, `decidedBy` against the chain's `approver`, action and requester
  against the `staged` record, executed-but-not-consumed, and the stored input
  against its stamped hash. Neither log is trusted on its own.
- **The file store's fold enforces the approval state machine** instead of
  replaying events blindly — `resolved` applies only to a `pending` record,
  `consumed` only to an `approved` one, and a repeat `created` for a known id is
  ignored. An appended line can no longer rewind a spent approval into a second
  execution.
- **The `sandbox` preset can no longer cause effects.** `execute` refuses at step
  0, *before* the consume CAS, so a sandbox server neither runs an approval nor
  burns it. `check_approval` stays visible and answers `dry_run`.
- **Bidi and invisible characters in the approval display are escaped, not
  deleted.** `U+202E` and the rest of the Trojan Source class, the zero-width
  characters and the TAG block now render as a visible `\uXXXX`. Deleting them
  would make a hostile string render as a clean one.
- **`orangerail status`'s audit FAILURE block writes to stderr**, so
  `orangerail status >/dev/null` no longer erases the one finding on that readout
  that must never be missed.

What none of this does: the chain hash is unkeyed, `hashAuditRecord` is a public
export, and the anchor is an unsigned `audit.head.json` beside the records it
anchors. An attacker with write access to the store directory can still rewrite
both logs consistently and pass verification. See
[What the audit log proves](./README.md#what-the-audit-log-proves).

### Added

- **`orangerail.governance.json` and `orangerail sync --accept-governance`.**
  `sync` now compares the live registry's governance posture — approval gate,
  approver roles, `where` guard, target — against a recorded baseline at your repo
  root, and exits 1 when the posture *weakens*: a gate removed, a `where` guard
  removed or rewritten, roles widened, an action retargeted, or a new action that
  is not gated. Strengthening is reported as `info:` and passes. Commit the
  baseline — its value is that a pull request removing an approval gate shows the
  change in its own diff. Limit: a functional `where` predicate records as the
  constant `functional`, so a rewrite of its body is invisible to the diff, and
  `sync` says so in its own output.
- **`orangerail approvals show <id> --full`** prints the staged input uncapped.
  Without it the input is capped at 40 lines / 2000 characters so the decision
  context (`id`, `action`, `status`, `requestedBy`) always stays on screen; the
  truncation states exactly how much was withheld.
- **`orangerail.config.ts` and `orangerail.config.mts` are discovered.** Every
  command now reads the same four names — `.mjs`, `.js`, `.ts`, `.mts`. TypeScript
  configs load through your own TS-capable runtime (`tsx`, or
  `node --experimental-strip-types`); orangerail bundles no loader.

### Changed

- **`orangerail init` refuses rather than overwrites.** It never writes over an
  existing generated path, and it treats any of the four config names as "already
  initialized" — a project that had migrated to `orangerail.config.ts` used to
  read as uninitialized and get its hand-edited ontology regenerated over.
- **`init` writes the file set even when the pre-flight check fails.** A missing
  runtime dependency or a failed smoke load now costs only the docs/studio
  handoff, with the reason stated; the files land and the exit code is 0.
- **`sync --accept-new` exits 1 when drift it could not resolve remains** (field
  drift, a proposal whose target file already existed, or weakened governance).
  It used to return 0 unconditionally, so a CI step that auto-adopted new models
  passed green with drift on the board.
- **Unknown flags and missing flag values are hard errors.** An unrecognized flag
  used to be ignored, so `orangerail status --confg /path/to/prod.config.mjs`
  printed a confident green report for the *local* project. A value flag whose
  value the shell ate used to fall back silently.
- **`orangerail init` generates for the Prisma major your repo resolves.** Prisma
  7 removed the no-argument client constructor, so the emitted
  `new PrismaClient()` could not construct a client at all on the version
  `npm install prisma` gives you today — `init` printed its success banner over a
  project that threw on every read and every write. It now detects the installed
  (or, failing that, declared) Prisma major and emits a driver-adapter
  construction on 7+, built from the adapter package the repo actually has:
  `@prisma/adapter-pg`, `@prisma/adapter-mariadb`, `@prisma/adapter-mssql` or
  `@prisma/adapter-better-sqlite3`. On Prisma 6 the generated bytes are unchanged.
- **`init` refuses instead of generating unrunnable code on Prisma 7 without an
  adapter.** The refusal names the adapter to install for your datasource
  provider, exits 1, and writes nothing. `orangerail sync --accept-new` is the
  other doorway that writes generated Prisma call sites, and it answers the same
  question the same way.
- **Every `init` refusal now exits non-zero.** "No Prisma schema or OpenAPI JSON
  found" printed on stdout and exited 0, so a scripted caller was told init had
  succeeded over a repo it never touched. It now prints on stderr and exits 1.
  The two *degrade* paths are unchanged and still exit 0: they write the whole
  file set and only skip the docs/studio handoff.

### Fixed

- `orangerail init` failed outright under pnpm: the pre-flight dependency probe
  used CJS resolution, which honors `NODE_PATH`, while the ESM loader that
  actually imports the generated code does not. The probe is now the ESM loader
  itself.
- Flags before the subcommand killed long-running commands: `orangerail --config
  ./c.mjs studio` printed "serving" and exited immediately.
- `orangerail mcp` wrote its `serving · governance active` line and its liveness
  heartbeat *before* the server actually started, so a host log read as a healthy
  start followed by a mysterious crash.
- `--port 0` printed `http://127.0.0.1:0` for a server listening on a real
  ephemeral port; `--port abc` produced a raw Node error that never named the flag.
- A large `approvals show` was silently truncated on a pipe, because
  `process.exit` discards whatever is still queued on stdout.
- The OpenAPI scanner emitted `z.string()` for `type: array` and `type: object`,
  handing the agent a contract that rejects every valid call. Both are now mapped
  structurally; the three shapes the IR cannot express (an array of arrays, an
  object with no declared properties, and nesting deeper than five levels) emit
  `z.unknown()` and are reported rather than faked. Non-JSON request bodies,
  the `prisma/schema/` folder layout, `__proto__` fields, and several dropped
  keywords are likewise mapped or reported instead of silently dropped.
- `orangerail init` could print its success banner over a project that cannot
  load or cannot serve: a case-only model-name collision lost a model, `--models`
  / `--sources` emitted actions importing files the run never wrote, a long model
  name made `orangerail mcp` refuse to boot, and a renamed model emitted a
  `prisma.<accessor>` that does not exist.
- `sync` printed `proposal: new action createRefund (from undefined undefined)`
  for Prisma-derived proposals, which carry no HTTP method or path.

### Documentation

- The audit log is no longer described as "tamper-evident" anywhere. What
  `orangerail audit verify` does and does not prove is stated exactly in
  [What the audit log proves](./README.md#what-the-audit-log-proves), along with
  the store-location hazard: `init` scaffolds the store inside the workspace the
  governed agent can write, and relocating it is the `dir` argument of
  `createFileStore` in your own `orangerail.config.mjs`.
- `orangerail-docs-gen` and `orangerail-studio` now ship a README;
  `packages/cli/README.md` covers install, `init`, and the full command surface.
- **[Adopting orangerail against an existing database](./docs/existing-database.md)**
  documents the on-ramp for the most common starting point — a live database and
  no schema file. It covers `prisma db pull` on both Prisma majors, what Prisma 7
  changes (`url` moves to `prisma.config.ts`, `.env` is no longer auto-loaded, a
  driver adapter is required), and the error text you get for each missed step.
  Every console block in it is a transcript of a run against PostgreSQL 16.14.
  The "nothing found" refusal now points at it.

## 0.1.0 — 2026-07-25

First public release. Five packages on npm: `orangerail` (the CLI),
`orangerail-core`, `orangerail-mcp`, `orangerail-docs-gen` and
`orangerail-studio`.

- `orangerail init` — deterministic Prisma / OpenAPI scanner that extracts an
  ontology from your code and generates a governed MCP server. No LLM calls, no
  API keys.
- `orangerail mcp` — a typed stdio MCP server over your declared objects, links
  and actions, with policy-gated actions staged for human approval.
- `orangerail approvals` / `orangerail audit verify` / `orangerail status` — the
  operator surface: the approval queue, hash-chain verification, and the posture
  readout.
- `orangerail studio` — a local, read-only map of your domain graph.
- `orangerail docs` — the agent-facing domain document (the prompt rail).
- `orangerail sync` — re-scan your sources and report drift.
