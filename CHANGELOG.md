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

**`<Object>_list` no longer accepts an arbitrary Prisma `where`.** This is the
breaking half of a security fix — read the Security section first for why. The
`filter` argument is now a **closed** JSON Schema built from the object's own
declared fields, published in `tools/list` and enforced by the server before the
value reaches your resolver. A rejected filter comes back as
`{ status: 'invalid_input', issues: [...] }` naming the offending keys.

Still accepted, on any field the object declares:

```jsonc
{ "status": "PAID" }                             // bare value = equality
{ "name": null }                                 // a nullable column
{ "total": { "gte": 10, "lt": 100 } }            // gt gte lt lte
{ "email": { "contains": "@example.com" } }      // contains startsWith endsWith
{ "id": { "in": ["c1", "c2"] }, "done": true }   // in, and a flat conjunction
```

No longer accepted:

- **Relation predicates** (`{ orders: { some: … } }`) — the vulnerability.
- **`AND` / `OR` / `NOT`.** A filter is a flat conjunction of field predicates;
  two bounds on one field still combine (`{ total: { gte: 10, lt: 100 } }`).
  `OR` has no replacement — issue two calls.
- **Any key that is not a declared field of that object.** If you removed a
  column from an object's zod schema, it is no longer filterable either — which
  is the point.
- **Operators outside the published set**, including Prisma's `mode:
  'insensitive'`, `notIn`, and the JSON-column operators.
- **`Json`, list and `BigInt` columns.** They are absent from the schema and
  refused: none has a leaf JSON type this server is willing to state, and a
  `z.bigint()` rejects a JSON number, so a `BigInt` filter could never have
  worked over this transport regardless.

The check runs in `orangerail-mcp`, not in generated code, so **you do not need
to re-run `orangerail init`** — upgrade the package and it applies. It also
covers hand-written resolvers: an object whose schema is not a `z.object`, or
whose fields are all undescribable, now publishes an empty closed filter and
refuses every filter sent to it. If you have a resolver with its own filter
language, declare those fields in the object's zod schema.

**An approval that was still `pending` when you upgrade must be re-staged.**
`createApproval` now stamps an `inputHash` over the approved payload, and
`execute` recomputes it before running anything. A record written by `0.1.0`
carries no such hash, so `execute` cannot bind the payload to the approval it is
about to act on and **refuses**: the approval is consumed and the call returns
`{ status: 'invalidated', reason: 'stale_approval' }`, with an `invalidated`
record on the audit chain. Nothing runs on an unverifiable payload. Ask the agent
to call the tool again and approve the fresh approval.

That reason is its own value, distinct from the `input` you get when a hash is
present and disagrees. Absence means the record was written by an older core;
`input` means somebody edited an approved payload. They are not the same finding
and orangerail no longer answers both with the same word — see Fixed.

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
for and stays green. Your **server keeps starting** in the meantime; it reports
that it cannot verify the posture it is enforcing, and withholds nothing. Locking
a project out of its own tooling for predating a file would be punishment, not
protection.

**`orangerail sync` now exits 1 on an unregistered ontology file.** It always
warned about one — a file in `ontology/` that the discovery convention does not
pick up and the config does not import, so nothing in it is registered — and then
printed `ontology is in sync with your sources` and exited 0. That file can hold
a whole set of governed actions you believe are live. If your CI runs `sync`, a
project carrying one goes red until you rename it to `.mjs` or import it
explicitly.

**`orangerail status` now exits 1 when the posture is weaker than the baseline**,
the same way it already does for a broken audit chain. An absent or unreviewed
baseline is reported on the readout but is not an error.

**A `sandbox` server no longer completes approvals.** If you were running one
against a store shared with a live server, it was executing real approvals; it
now records a `dry_run` and leaves the approval `approved` for the live engine to
complete. See Security below.

### Security

- **A `<Object>_list` filter could read an object type the server never
  exposed.** `filter` was advertised as `{ "type": "object" }` and handed to the
  object's `resolve.list` untouched, which for a generated Prisma resolver is
  `findMany({ where: filter })`. That is not an untyped parameter — it is
  Prisma's whole `where` grammar, including relation predicates. Against a
  two-model SQLite project generated with `orangerail init --models Customer`,
  so that `Order` was never in `ontology/` and `tools/list` carried **no Order
  tool at all**, this call:

  ```json
  { "name": "Customer_list",
    "arguments": { "filter": { "orders": { "some": { "secret": { "startsWith": "h" } } } } } }
  ```

  returned exactly the customers whose (unexposed) order secret began with `h`.
  Walking that prefix over a 36-symbol alphabet recovered the seven-character
  column in full in 151 `Customer_list` calls, using no other tool. Any object
  type reachable by a relation from an exposed one was readable this way,
  including one the operator had deliberately kept out of `ontology/`. `filter`
  is now checked against the object's own declared fields before it reaches any
  resolver; see **Upgrading**.
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

- **`hostApprovalPrompt` — engage the agent host's own permission prompt.**
  Off by default. Set it in `orangerail.config.mjs` to
  `'ungoverned-actions'` and the actions you declared *without*
  `policy: { approval: 'required' }` — the ones that execute on call, with no
  orangerail gate in front of them — carry
  `_meta: { "anthropic/requiresUserInteraction": true }` in `tools/list`, which
  makes Claude Code v2.1.199+ prompt on every call to them. `'all-actions'`
  extends it to governed actions too (which only stage, so it buys a checkpoint
  before the approval queue rather than before a write). Read tools and
  `check_approval` are never annotated: `check_approval` is polled in a loop.
  The key is vendor-prefixed per the MCP `_meta` rules, so every other host
  ignores it and nothing changes there. It is enforced by the **client**, so it
  is a second checkpoint on top of orangerail's gate and never what makes that
  gate hold. Turn it on deliberately — a flagged tool's prompt survives
  `bypassPermissions`, offers no "don't ask again", is not skipped by an allow
  rule, and in `dontAsk` mode the call is denied instead of asked.
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
- **`orangerail init` records that baseline**, so drift detection works in a
  default install instead of only after someone remembers a second command. It is
  stamped `"recordedBy": "init"` and its own note says what it is: the posture
  init *generated*, before anyone reviewed it. `sync` and `status` keep saying
  "not yet reviewed" until you run `--accept-governance`, which re-records it as
  `"recordedBy": "sync"`. A baseline written before this field existed reads as
  `"sync"` — only `--accept-governance` could have written one — so nothing about
  an existing project changes.
- **`orangerail mcp` refuses to serve an action whose posture weakened.** The
  action is absent from `tools/list` and the engine will not resolve it by name,
  so it can be neither staged nor executed; every other action and every read
  tool is served normally, and the startup line names what was withheld. Sync
  reporting the drift was not enough on its own: an un-gated action is
  *legitimately* un-gated, so it ran, and the audit chain recorded nothing
  anomalous — `audit verify` stayed green. Recovery is
  `orangerail sync --accept-governance`, which leaves a diff in a committed file;
  there is deliberately no `--force`.
- **`orangerail status` shows a `baseline:` block** next to the action counts:
  matching, unreviewed, absent, unreadable, or drifted with each weakened action
  named. `18 approval-gated, 1 auto` is a true sentence about an ontology someone
  just un-gated, and on its own it reads like health.
- **`orangerail approvals show <id> --full`** prints the staged input uncapped.
  Without it the input is capped at 40 lines / 2000 characters so the decision
  context (`id`, `action`, `status`, `requestedBy`) always stays on screen; the
  truncation states exactly how much was withheld.
- **`orangerail.config.ts` and `orangerail.config.mts` are discovered.** Every
  command now reads the same four names — `.mjs`, `.js`, `.ts`, `.mts`. TypeScript
  configs load through your own TS-capable runtime (`tsx`, or
  `node --experimental-strip-types`); orangerail bundles no loader.
- **Every package declares `engines.node`.** `orangerail` and `orangerail-mcp`
  require Node `>=20.0.0`; `orangerail-core`, `orangerail-docs-gen` and
  `orangerail-studio` require `>=18.0.0`. None of them declared anything before,
  so npm installed them onto a runtime that could not load them without a word.
  It now warns at install time (`EBADENGINE`) instead.

### Changed

- **`<Object>_list` publishes the filter it will actually accept.** The schema is
  built from the object's own declared fields — each one as a bare value or a
  bounded operator object, with an enum column's members enumerated — and it is
  closed. The same derived spec renders the schema and gates the call, so the
  published grammar and the accepted grammar cannot drift apart: a caller that
  obeys the schema is never refused, and a caller that ignores it never reaches a
  resolver. See **Upgrading** for what that removes and **Security** for why.
- **Both read tools name the object's relations.**
  `List Customer records. Relations: has many Order.` The links come from
  `registry.listLinks()`, which the server had never called — so the graph
  `orangerail init` derives from your Prisma relations reached `orangerail
  studio` and `orangerail docs` and stopped there. This is knowledge and nothing
  else: there is no join, no aggregate and no traversal tool, the read surface is
  still get-by-id plus a filtered, paginated list capped at 200 rows, and naming
  a relation does not let an agent follow one. An object with no links is
  byte-identical to before.
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
- **One exit-code contract for `sync`, derived in one place.** **0** — nothing to
  act on, only `info:` lines printed. **1** — any unresolved finding: a proposal,
  field drift, an unregistered ontology file, a weakened posture, or a project
  with actions and no baseline. **2** — the run could not answer at all: the
  config would not load, the baseline could not be read, or the baseline could not
  be written. `--accept-new` and `--accept-governance` lower the code only for
  what they actually resolved, and `sync --help` states all three instead of
  promising "exit 1 on drift" while one path exited 0.
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

- **An approval orangerail could not verify was reported as one somebody had
  tampered with — and the version skew that produces it was invisible.** A
  project whose `orangerail.config.mjs` resolves `orangerail-core@0.1.0` while
  the `orangerail` binary running it resolves a newer core loads two cores in
  one process. The old one creates approvals without an `inputHash`; the new one
  refuses to execute an approval it cannot bind to its payload. The composition
  reports success at every step and completes nothing: staging returns an id,
  `approvals approve` prints `approve ok (approved)`, and execution consumes the
  approval and performs no write. A reviewer who hit this concluded orangerail
  could not complete a governed write at all, and nothing in the tool contradicted
  them — the refusal came back as `Invalidated (input).`, whose documented meaning
  is "the payload was swapped in the store after a human approved it".

  Refusing is still right and is unchanged: an unbindable payload never runs, and
  the approval is still spent. What changed is that orangerail now tells the two
  apart. An ABSENT hash returns `reason: 'stale_approval'` — the record predates
  the running core and the action must be staged again — while a hash that is
  present and disagrees keeps `reason: 'input'`, the tampering case. The MCP
  message tells an agent the approval is spent and that re-staging is the move,
  and deliberately says nothing about which versions are installed: that is the
  operator's, and it goes to the operator.

  The skew itself is now detected before it can cost an approval. `orangerail
  mcp` and `orangerail status` check whether the `orangerail-core` your config
  imports is the one the CLI runs on, and say so in the same block as the
  governance warnings — naming the consequence (no governed write will complete),
  the fix (align the versions, then re-stage anything pending), and what it means
  if you did not just upgrade. `orangerail status` exits 1 on a skew. Two copies
  of the SAME version are reported as a duplicate install and are not an error;
  they agree today and are one partial upgrade from not agreeing.

  The check is keyed on module-instance identity — a `Symbol.for` token
  `createRegistry` stamps — and not on a version string. The version string was
  never trustworthy here (`orangerail-core` exports `version = '0.0.0'` while its
  `package.json` says `0.1.0`), the copy whose version matters most predates any
  field a check could read, and equal versions do not imply one instance anyway.

  The approval surfaces carry it too. `approvals show` prints a `binding: NONE`
  block above the payload for a record that cannot execute, `approvals list`
  marks those rows `[UNEXECUTABLE]` and counts them, and `approvals approve`
  warns on stderr next to its `approve ok` that nothing will be written.

- **`orangerail studio` watched your whole `node_modules` on Linux.** Live
  reload used one `fs.watch(..., { recursive: true })` over the config
  directory. macOS and Windows hand that to the OS for one watch; every other
  platform falls through to Node's userland walk, which opens a separate inotify
  watch descriptor per file and per directory — 3611 of them for a 3000-file
  `node_modules`, measured on Linux. Studio now watches each directory
  individually, skipping `node_modules` and dot-directories, capped and with a
  warning when the cap bites. A watch that fails now costs live reload in that
  one directory instead of killing the server, and deleting a watched file no
  longer crashes studio on Node 20.0-20.12 or 22.0 (nodejs/node#52349). Edits
  inside `node_modules` or a dot-directory no longer trigger a reload.

- **The published bundles stripped the `node:` prefix off every builtin import.**
  Source uses `node:fs`, `node:readline/promises` and so on throughout, but tsup
  rewrites them to bare specifiers unless told not to, and `0.1.0` shipped with
  the rewrite on. A bare name resolves against `node_modules` first, so any
  package of that name shadows the builtin; and on a runtime without the bare
  builtin the loader answered `Cannot find package 'readline'` — pointing the
  user of a governance tool at a long-abandoned third-party package on npm. All
  five packages now keep the prefix, and the build fails if one ever loses it
  again.
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

- **The README leads with the argument rather than the inventory.** It opened first on
  approval gates, then (correctly) on the generated surface — but both were descriptions of
  outputs, and a reader finished the first screen knowing what `init` writes and not why they
  would want it. The opening now makes the case: a host permission prompt asks *per call*, so
  it depends on sustained human attention and erodes at the rate the agent becomes useful,
  while a generated surface is finite, declared, committed and reviewed once, so there is
  nothing to decide per call. The conclusion is the inversion — you can let the agent run
  *because* you know what it can reach — with an explicit paragraph refusing the slide from
  "bounded" to "safe". Approval remains a property of an action. The generated tool table is
  still there, one section down. Nothing in the security wording moved, and the co-resident
  precondition is still on the first screen.
- **The three-row comparison is on the first screen:** `execute_sql` on a general-purpose
  database MCP server (anything the connection can), the same server under `--read-only`
  (read anything in the database), orangerail (exactly the calls you declared, argument shapes
  included). The point being drawn is that the menu used to be everything-or-read-only with no
  middle. The `--read-only` row is read off source, not asserted: in `supabase/mcp`,
  `execute_sql` is declared `readOnlyBehavior: 'adapt'` — "stays available in read-only mode,
  adapts behavior" — so it stays on the tool list with the same single `query: z.string()`
  parameter, while `apply_migration` takes the default `'exclude'` and additionally throws
  `Cannot apply migration in read-only mode.`. The flag decides whether the SQL may write; the
  reach is the whole database either way.
- **The filter exfiltration is in the README as an illustration, under "Typed is not
  enforced".** It is the concrete demonstration that a schema the agent is shown and the
  server does not check is documentation, not a boundary — the probe, the boolean oracle, the
  151 calls, and a pointer to the full account here. It also states where the check actually
  lives: `orangerail-mcp`'s `handleList`, **not** codegen. The generated resolver still builds
  `findMany({ where: filter })` from whatever it is handed, so a caller that imports
  `ontology/*.mjs` and invokes `resolve.list` directly gets the unbounded `where` back. The
  README now says outright that `ontology/` is what you review and `orangerail mcp` is what
  enforces.
- **The install path discloses that `0.1.0` is the vulnerable release.** The README told a
  reader that v0 is on npm at `0.1.0` and pointed them at `npx orangerail init` without
  mentioning that `0.1.0` is the build whose read filter was never checked. It now says so
  where the reader sees it before installing — on the first screen and again at the top of the
  Quickstart — names that the fix is merged and unreleased, and states the consequence for
  someone who installs `0.1.0` anyway: assume any object reachable by a relation from an
  exposed one is readable, whether or not it is in `ontology/`.
- **The relation graph is described where it actually goes.** `orangerail init` derives a
  `defineLink` per relation pair with a `cardinality`, and the README used to leave a reader
  to assume the agent sees it. It does not: `packages/mcp` never calls `listLinks()`, so the
  only consumers today are `orangerail studio` and `orangerail docs`. The studio section now
  says that outright, and no part of the README describes the MCP surface as relation-aware.
- **Four scope limits are stated in the body rather than implied.** A second route to the
  database defeats the gate — demonstrated, not hypothesized: with orangerail installed and
  every write gated, a co-resident Postgres MCP server on the same database deleted five rows
  with zero approvals and nothing on the chain. There is no aggregation, no join and no
  free-form query: the generated reads are a `findUnique` and a `findMany` capped at 200 rows,
  which also means a fan-trap aggregate cannot be asked through orangerail — an absence of
  capability, not a guard, and the README says so in those words. There is no DDL, so
  migrations go around orangerail entirely and belong in your migration tool. And a bulk
  intent costs one approval per row today, because the generated actions take a single id and
  there is no approve-all.
- **A comparison section, with every claim checked against the shipped package.**
  `openapi-mcp-generator` is acknowledged as prior art on the OpenAPI half and named as the
  better choice if one tool per REST operation is all you want; Prisma's local and hosted MCP
  servers are described by the tools they actually register; Supabase's `list_tables` is
  described exactly, including that foreign keys arrive as a `foreign_key_constraints` array
  inside the introspection payload and only under `verbose: true` — and that orangerail is not
  ahead of it on relations in the way that could be read to imply.
- `orangerail docs` is listed under v0 scope. It shipped in `0.1.0` and was the only command
  the scope list omitted.
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
