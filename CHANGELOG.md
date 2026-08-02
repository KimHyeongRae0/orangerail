# Changelog

All five packages — `orangerail`, `orangerail-core`, `orangerail-mcp`,
`orangerail-docs-gen` and `orangerail-studio` — are versioned and released
together, so one entry covers all of them.

This is a v0 project: the API is the design target and it will move before 1.0.
Anything that changes what an existing project does on upgrade is called out
under **Upgrading** rather than buried in a list.

## Unreleased

Everything below is merged on `main`.

### Upgrading

**A `BigInt` column is now a decimal string on the wire, everywhere.** Published
schema, action input, resolver output, cursor, filter operand, audit record. If
you already have a project generated against a schema with a `BigInt` column,
**re-run `orangerail init`** — the change is in the emitter as well as in the
transport, and `orangerail sync` will report drift until you do.

What that means at each surface:

```jsonc
{ "id": "9007199254740993" }                    // an action input — a string, always
{ "id": { "gte": "9007199254740993" } }         // a filter operand — a string, always
{ "id": { "contains": "900" } }                 // refused: not on Prisma's BigIntFilter
{ "id": 9007199254740993 }                      // refused: JSON.parse rounds this
```

`tools/list` publishes such a field as `{"type":"string"}` with a `^-?\d+$`
pattern instead of the `{"type":"integer"}` it used to claim, and the `_list`
filter now **carries** the column (it used to drop it) with `equals`, `gt`,
`gte`, `in`, `lt`, `lte` and `not` over string operands. `contains`,
`startsWith` and `endsWith` are absent because Prisma's `BigIntFilter` does not
have them — advertising them would be a filter the server accepts and the
datasource then refuses.

Leading zeros are accepted (`"007"` names the row `"7"` names); surrounding
whitespace, `"1.5"`, `"0x10"` and `""` are refused with the field named. A
`BIGINT UNSIGNED` value above 2^63-1 can be listed but not targeted by key —
that is Prisma's signed `BigInt` scalar, and it is written down in
[docs/limits.md](docs/limits.md).

**A repo carrying another database's driver adapter now refuses instead of using
it.** On Prisma 7, the adapter follows your schema's `datasource` provider. If
your provider is `mysql` and the only supported adapter you have installed is
`@prisma/adapter-pg`, `init` and `sync --accept-new` refuse with the exact
`npm install` to run, where they previously generated an ontology whose client
connected through the wrong driver. Install the adapter your provider names.
Projects already generated that way keep their emitted `PrismaPg` line until you
re-run `orangerail init` — the choice is baked into the generated files.

**A declarative `where` clause now refuses a row that does not match the shape
its object declares.** If your ontology says a field is a required string and the
row your resolver returns does not carry it, or carries something else, the
action is refused with a new outcome — `target_nonconforming` — instead of being
evaluated against a value nobody checked. Actions that were staging on such a row
will start refusing, which is the point: `undefined !== 'soldout'` is `true`, so
a `neq` clause written to stop an action was permitting it.

The refusal is scoped to the ONE field the clause reads. A row that fails its
schema anywhere else passes exactly as before, so an ontology that is imprecise
in a column no policy consults is unaffected. A field declared `.optional()` that
is absent is conforming. A functional `where` predicate is unchanged and
unchecked — the engine cannot know which fields it reads.

If an action starts refusing, the audit record names the field and quotes what
the schema wanted; `orangerail sync` is the tool that reconciles the declaration
with the datasource. A transport is told the field and not the stored value.

### Security

- **The scaffolded store sits where the governed agent can write it, and one
  appended line executes a gated action.** `orangerail init` puts the approvals
  queue and the audit chain inside the project it just scanned
  (`.orangerail/store`). `docs/audit-log.md` already said that was the wrong
  place when the agent also has file tools over that repo — but it described the
  effort as the re-chaining attack: delete audit records, re-chain the survivors
  with the public `hashAuditRecord`, re-anchor `audit.head.json`, edit
  `approvals.jsonl` to match.

  Measured, the bar in the shipped default is **one appended line**:

  ```json
  {"type":"resolved","id":"<staged id>","decision":"approved","decidedBy":"local-dev","decidedAt":"…"}
  ```

  The approvals log is event-sourced, so that line folds the approval to
  `approved`; the next `check_approval` returns `{"status":"executed"}` and the
  row is gone. No hashing, no re-chaining, no edit to `audit.jsonl` — the
  approval gate reads the approvals store, and the audit chain is consulted by
  `audit verify` and by nothing on the execution path.

  Nothing here makes that store tamper-proof, and nothing claims to. A key
  beside the file it protects buys nothing, and refusing to start over a store
  location would cost the operator their server while deleting the store stayed
  an available downgrade. **The default location is unchanged**, for the same
  reason: a tool that writes to `/var/lib` or `$HOME` on `init` is a tool people
  stop running. What changed is that it is no longer silent.

  - `orangerail init` names the store in its closing summary and says, in one
    clause, that an agent with file tools over this directory can write it.
  - The generated `orangerail.config.mjs` carries the relocation as a commented
    one-liner directly under the `createFileStore` call, with the argument above
    it — the fix is visible where the decision is, not only in a doc.
  - `orangerail status` reports the resolved store directory and whether it is
    inside the project on every run, in the register of `hosts:`. It is a fact,
    not an alarm: **the exit code is unchanged**, since a health check that
    failed on the configuration the tool ships is one nobody runs. Paths are
    compared as resolved real paths, so a relative `dir` and a symlink landing
    back inside the project both answer on the location rather than the
    spelling.

  `orangerail audit verify` does catch the forgery, and now cannot stop doing so
  quietly: the exact sentence is pinned by a test.

  ```
  forged approval <id>: executed at seq 2 with no "approved" audit record — no human decision was ever recorded
  ```

  Read that as detection after the write, never as prevention. `docs/audit-log.md`
  now states the measured bar alongside the re-chaining attack it used to lead
  with.

- **The `where` gate failed closed on no row and open on a wrong one.**
  `defineObject` stored the schema and nothing ever parsed a resolver's output
  with it, so the gate read a property off a row nobody had checked. A row
  missing the declared field yielded `undefined`, and `undefined !== 'soldout'`
  is `true` — the clause written to stop the action permitted it, and the action
  executed. Measured against the project's own flagship policy:

  ```
  CONTROL (status: 'soldout')          -> rejected_where          <- the gate works
  DRIFT   (status absent)              -> approval_pending -> executed
  DRIFT   (status: { code: 'soldout' })-> approval_pending
  ```

  `neq` is the operator that opened; `eq`, `in` and the ordered ops failed closed
  by accident of their comparison rather than by anyone's decision. Reachable
  without exotica — a resolver that forgets a field, a `select` that narrows one,
  a column renamed in a migration the ontology did not follow.

  The row is now checked against the object's declared schema before the clause
  is evaluated, and the refusal is `target_nonconforming` rather than
  `rejected_where`: "the condition did not hold" and "the row did not match what
  you declared" are different repairs, and only the first one existed. See
  **Upgrading** for what changes for an existing project.

  Two read surfaces follow the same verdict. `<Object>_get` and `<Object>_list`
  stay total and stop serving a non-conforming value silently — the field is
  marked with `<UNRENDERABLE — …>`, the vocabulary the approver view and the
  studio already share, and the call still succeeds — and the audit record's
  prior state now says the row is not what the object declares instead of showing
  a row with a field quietly missing from it.

### Fixed

- **`orangerail init --yes` started a server and never returned.** `--yes` is the
  flag you pass when nobody is going to answer a prompt — a CI job, a script, a
  Dockerfile — and it ended by launching the studio, which waits for a person.
  Measured on a cold start: scaffolding complete at 0.45s, `serving on
  http://127.0.0.1:4820` at 0.46s, still running when it was killed 30 seconds
  later. **`--yes` now implies `--no-studio`.** Nothing is lost, because `init`
  already closes by naming ``orangerail studio`` as the next command. An explicit
  `--studio` alongside `--yes` still serves, and the interactive path is
  untouched: on a terminal without `--yes`, `Launch studio and open browser?
  [Y/n]` is still asked and still defaults to yes. Anything scripted that relied
  on `init --yes` coming up on a port needs `--studio` added.

- **A name with a `|` in it rewrote every other column of ANALYTICS.md.** The
  roster interpolated each stored value straight into a markdown table row, so a
  Jira display name of `Ann | 9 | 999 | yes` shifted every metric one cell left
  per pipe: the rendered row read 999 tickets and `yes` story points for someone
  with one ticket and five points. A display name carrying a line break ended the
  table where it sat. And a story-point total that overflowed to `Infinity` — two
  values that each pass the scanner's finite check and sum past it — printed as
  `Infinity` in the report while `data/employee.json`, written by the same run,
  carried `null`.

  Every roster cell is now read through the same walk `approvals show` and
  `/api/instances` use. A pipe or a line break in a name is escaped and the name
  is kept whole — it is a real name, and dropping it to protect the table would
  be the same lie in the other direction. A value the column cannot carry is
  named in the vocabulary those surfaces already print
  (`<UNRENDERABLE — the number Infinity>`), never printed as something else and
  never dropped. A row missing a field gets one marker in that cell and its other
  cells verbatim, instead of ending the whole `init` run before a byte is
  written. A conforming export's ANALYTICS.md is byte-identical to before.

- **The driver adapter was picked by install order, not by the schema.**
  `@prisma/adapter-pg` heads the table of adapters orangerail knows how to
  construct, and the selection took the first one the repo carried. A schema
  declaring `provider = "mysql"` in a repo that also had the PostgreSQL adapter
  installed got `new PrismaPg(url)` emitted against a MySQL connection string —
  and `init` printed its whole green summary and exited 0 over it, so the first
  sign was a tool call failing at the datasource. A monorepo serving two
  databases and a project that migrated to MySQL without uninstalling the old
  adapter both produce that repo.

  The schema's `datasource` provider now decides it, in `init` and in
  `sync --accept-new` alike. There is deliberately no fallback to install order
  once the provider is known: a declared provider whose adapter is absent gets
  the refusal that was already written for it — narrowed to that provider, with
  the one `npm install` to run — because reaching past it to a different adapter
  is the defect. A provider no adapter in the table serves (`mongodb`,
  `cockroachdb`) gets the same refusal listing every option.

  A schema declaring **no** provider is unchanged: install order still answers,
  because nothing better is available, and its generated bytes are identical.

  The refusal's finding now names the provider — ``no driver adapter for `mysql`
  is installed`` — because the repo it reaches may well have a supported adapter
  in `node_modules`, and the old blanket "no supported driver adapter is
  installed" would have sent that reader looking for an install they had already
  run. A schema declaring no provider keeps the blanket wording, which is what is
  true there.

- **`--exclude payment` was refused on a schema declaring `Payment`.** The
  comparison was an exact string match, so the flag that keeps card data off the
  agent's surface failed on the casing an operator naturally types: a Postgres
  user types the table name `psql` shows them, and the scanner reports the Prisma
  model name. The remedy `orangerail sync` prints in its own report —
  `orangerail sync --exclude <name>` — failed the same way for the same reason.

  `--models` and `--exclude` now resolve what was typed to the scanned name, and
  **the scanned name is what gets recorded**. That distinction is the fix, not a
  detail of it: everything downstream is exact-match set membership, so accepting
  `payment` and writing `"excluded": ["payment"]` into `orangerail.governance.json`
  would have produced a committed deny-list that matches nothing — a correct
  looking file with a permanently red `sync` behind it.

  Case is the only difference accepted. There is no prefix, plural or
  edit-distance rule: `payments` and `pay` are still refused, naming the models
  the repo has, because a flag that decides which tables an agent can reach must
  not guess. Two models whose source names differ only in case (`Order` and
  `order`, which the scanner already de-collides to `Order` and `order_2`) refuse
  with a diagnostic naming both rather than resolving to one of them.

- **One `BigInt` column took the whole model out of service.** Measured against
  MySQL 9.7.1 with prisma / `@prisma/adapter-mariadb` 7.9.1: every `_get` and
  `_list` threw `Do not know how to serialize a BigInt` and reached the agent as
  `internal_error`, the one status carrying no actionable text. Every `update`
  and `delete` was **uncallable** — no JSON value satisfies `z.bigint()`, so
  `1`, `"1"`, `null`, `[1]` and a raw wire literal were all refused with
  `Input rejected: "id" expects bigint.` And `create` landed the row in the
  database, returned `internal_error`, and wrote **no terminal audit record** —
  so the row existed with nothing in the chain saying it had been written, and
  the agent's next move was to retry it.

  One `BigInt` **foreign key** did all of that to a model whose own primary key
  is an `Int`, because the prior target row is read and stamped on the audit
  record before the write runs. There was no partial-adoption escape: excluding
  the BigInt-keyed models did not save a child table.

  This is not an exotic schema. `$table->id()` — the first line of every default
  Laravel migration since 5.8 — is `BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY`,
  and Rails has defaulted to bigint primary keys since 5.1. In a stock schema
  from either, every table's key and every foreign key is a `BigInt`.

- **`tools/list` invited the wrong row.** A `BigInt` field published
  `{"type":"integer"}`, which is what a JSON number is for — and `JSON.parse`
  rounds one above 2^53. A request for id `9007199254740993` reached the
  resolver as `9007199254740992` and came back as a clean
  `No Signed with id "9007199254740992".` — a different row, reported as an
  ordinary not-found. No layer downstream could detect that, so no number is
  accepted anywhere now.

  Verified end to end against a live MySQL 9.7.1: reads at `9007199254740993`,
  cursor pagination stepping across 2^53 with no overlap, `update` and a gated
  `delete` → `approvals approve` → `check_approval` returning `executed` with
  the row observably gone, and `orangerail audit verify` reporting
  `audit chain OK`.

- **A malformed id no longer reaches the driver.** `"not-a-number"`, `""`,
  `"1.5"` and `"0x10"` take the ordinary not-found path on a read and are
  refused by name on a write, instead of becoming
  `Cannot convert not-a-number to a BigInt` redacted down to an opaque
  `resolve_error`.

- **An action result carrying a `BigInt` no longer costs the audit record.**
  Results are rendered to their decimal form before the engine hashes them, so
  the `succeeded` record is written for a write that succeeded — which is what
  `verifyAudit` was flagging the absence of.

A schema with no `BigInt` column emits **byte-identical** output, asserted in
full against a reference captured on `main`.


- **A project scaffolded by `npx prisma init` on Prisma 7 got a green `init` and
  an ontology whose every tool call failed.** Prisma 7's `prisma init` writes
  `generator client { provider = "prisma-client"  output = "../generated/prisma" }`.
  That generator writes the client into `output` and puts **nothing** into
  `@prisma/client`, but the emitter imported `@prisma/client` unconditionally —
  so `init` printed its full success banner, exited 0, and the first read came
  back with `Cannot find module '.prisma/client/default'`. The remedy that error
  named (`npm install @prisma/client && npx prisma generate`) was the exact pair
  of commands the user had already run, and re-running them could never fix it.

  The scanner now reads the generator block it used to skip and emits the import
  against the resolved output path. Verified end to end against MySQL 9.7.1 with
  prisma 7.9.1 and `@prisma/adapter-mariadb`: the same schema `prisma init`
  produces now returns rows on the first `<Object>_list` call.

  A schema on `provider = "prisma-client-js"`, or with no generator block, is
  unchanged — byte for byte, asserted against a captured reference.

- **`init` refuses instead of guessing when the client's location cannot be
  read.** A `prisma-client` generator with no `output`, an `output` that is an
  `env()` call, or an `output` outside the project each refuse before a byte is
  written — exit 1, no `ontology/`, no config, no `orangerail.governance.json` —
  naming the field to add and the `prisma-client-js` alternative. Prisma's own
  default output differs by generator and version, so a guess would only move
  this defect to a different path.

- **The resolve-time diagnostic no longer prescribes a remedy that cannot
  apply.** A missing GENERATED client now names the generator's own output path
  and asks only for `npx prisma generate`, because installing `@prisma/client`
  can never populate a directory the user's schema names. A client that is
  present but unloadable — the `prisma-client` generator emits TypeScript and
  nothing else, and Node runs it natively only from 22.18 — is a third case with
  its own sentence, instead of being read as "generated from a different schema"
  because Node raises it as a `TypeError`.


- **A governed write could land with nothing in the audit chain, and the
  approval behind it could be orphaned for good.** Any value `JSON.stringify`
  throws on — a row that points back at itself, a driver id returned as a
  `BigInt`, an object whose `toJSON` explodes — threw from inside `appendAudit`.
  Two failures followed from that one gap.

  The terminal append was wrapped in `.catch(() => undefined)`, argued as "do not
  hide the side effect". Measured, it did the opposite: the row was written, the
  agent was told `an unexpected internal error`, and `audit.jsonl` held an
  `execution_started` with no terminal record at all. `audit verify` called it an
  incomplete execution, and the agent — told the call had failed — would retry a
  write that had already happened.

  The other failure was worse, because there was no way back from it. The
  `execution_started` append ran AFTER the consume CAS, so a refused append left
  the approval spent with nothing recorded against it: `check_approval` then
  answered `"Already executed (consumed)."` about an execution that never
  happened, `orangerail approvals approve` refused the same id as
  `already_resolved`, `audit verify` failed permanently, and every boot printed
  `serving, but AUDIT CHAIN FAILED`.

  Rendering for the chain is now total and states what it replaced
  (`"self": "[unserializable: circular reference]"`), so no value can make an
  append fail. The `execution_started` record is now written BEFORE the approval
  is claimed, so an append that fails leaves the approval executable — fix the
  store and the same approval id completes. The claim is still a single-winner
  CAS immediately before the action runs, so two concurrent `check_approval`
  calls still cannot both execute; the loser records an `execution_aborted`
  against the started record it wrote, and a race no longer reads as a replayed
  approval. See `docs/audit-log.md`.

- **`orangerail audit verify` now tells a refused terminal record from a process
  that died.** If an action ran and the store refuses its `succeeded`/`failed`
  record, the engine appends a minimal `terminal_unrecorded` marker and
  verification reports `terminal record could not be written for <id>` — a
  landed write you have to reconcile — separately from
  `incomplete execution for <id>: started but never finished`, which says you do
  not know whether it landed. If even the marker cannot be appended, `execute`
  returns the new `audit_unrecorded` outcome, carrying the result and refusing to
  report a success nothing recorded.

  An approval that was ALREADY orphaned still fails verification. This prevents
  new ones; it does not launder the ones on your chain, and nothing rewrites
  history to make them go away.


- **`orangerail approvals show` crashed on the one screen the gate exists for.**
  A staged action whose target row carried anything `JSON.stringify` refuses to
  print — a circular reference, a function-valued column, a symbol key, a
  `BigInt`, a getter that throws — ended the command at
  `orangerail: Converting circular structure to JSON` with exit 1 and nothing on
  stdout.

  What made it expensive is how healthy everything around it looked. The
  approval staged correctly, its own input (`{"id":3}`) was ordinary JSON,
  `approvals list` showed it waiting, and `approvals reject` worked. The only
  thing that did not work was READING what was being decided, so an approver
  could see that something was pending and could act on it only by rejecting it
  blind. A gate exists so a human can look at a staged action before it runs;
  this removed exactly that and left the rest standing.

  The renderer behind `approvals show` (and `approvals list`) is now total. Any
  part of a value that cannot be printed as it is becomes a marker naming what
  was there, and the block is followed by a list of those fields by key:

  ```console
  $ orangerail approvals show dc585cef-c4af-4ba2-bb36-f1d4d04bfc66
  target (current state, read now):
  {
    "id": "p3",
    "title": "Blue Mug",
    "self": "<UNRENDERABLE — a circular reference back to a value already shown above>",
    "loadOrders": "<UNRENDERABLE — a function (loadOrders)>"
  }
    NOT SHOWN AS-IS — 2 field(s) above are markers, not values:
      $.self — a circular reference back to a value already shown above
      $.loadOrders — a function (loadOrders)
  ```

  Nothing is dropped quietly, which is the half of this that is not about the
  crash. `JSON.stringify` also DELETES what it cannot print — an `undefined`
  column, a function, a symbol-keyed field — and prints `NaN` as `null` and a
  `Map` as `{}`. On a screen whose entire job is showing a human what they are
  about to authorize, a row rendered with a field silently missing is the same
  defect as a row that never rendered: the decision is made without it either
  way. Every one of those now appears with its key and a reason.

  The marker list is printed AFTER the default view's length cap, so an approver
  is told which fields are not verbatim even when the cut lands above them.
  Default mode still truncates a large row and still says so with exact counts;
  `--full` prints everything, markers and list included, and truncates nothing.
  An ordinary approval — everything about it serializable — renders byte for
  byte what it always did, which a golden-output test now holds in place.

  `approvals show` also no longer loses the screen to a `redactPrior` mask that
  throws. That is reported as `COULD NOT READ`, the state this view already had
  for a target read that failed, rather than as an exit code.

  Fixed in the `orangerail` CLI. `approvals show` remains a read command and
  writes nothing.

- **A write that landed and was never recorded was reported to the agent as a
  failure.** `audit_unrecorded` — the outcome that means "the side effect
  happened and the audit chain holds nothing about it, not even the minimal
  marker" — had no branch in the MCP server, so it fell to `default` and the
  agent was told `Unexpected execute result.` with status `error`.

  An agent told its write failed retries it, so the transport was reintroducing
  the duplicate write the engine had just been fixed to stop. It now has a
  status of its own and a sentence that carries both halves and the instruction:

  ```console
  Executed, and NOT recorded. The action ran and its side effect has already
  landed — the write is done — but the audit chain holds no terminal record of
  it, not even the minimal marker, because the store refused every append. Do
  NOT retry this call and do NOT re-stage the action: either one repeats a write
  that has already happened. The store error is withheld; an operator can read
  it in the host log and reconcile the chain under correlationId "…".
  ```

  "Do not re-stage" is there for the gated path, where the approval behind the
  call is already spent: re-staging is not a retry, it is a second authorization
  for a second write. The action's own return value comes back with it, so
  wanting the result is never a reason to run the write again — and a return
  value this transport cannot serialize is named rather than allowed to take the
  sentence down with it. The store error follows the same redaction rule every
  other failure does and goes to the operator sink under the same correlationId,
  which for this status is the only place it survives.

  Reported on both paths — an ungoverned action answers through `stage`, a gated
  one through `check_approval` — and the `default` branch is still there, and
  still reachable, for a status from a core this build predates.

- **`orangerail studio` still died on a row it could not print.** The approver's
  screen was made total; the studio does not go through it, and served its
  instance rows straight through `JSON.stringify`. A `BigInt` column threw
  inside a `node:http` request handler, which is an uncaught exception, which
  ends the process — a browsable map of the ontology killed by one column of one
  row.

  The rows are now walked by the same renderer, where they enter the CLI rather
  than at the response: between the two sits the snapshot builder, which sorts
  by `accountId`/`id`, and a comparator that throws on one exotic key emptied
  the *entire* snapshot into the gather's catch. A page that silently blanks is
  no better than one that crashes.

  `/api/instances` serves the marker in place, plus the list of every field that
  is a marker rather than a value — derived from the walk, never from the
  rendered text, so a row carrying the literal marker string shows up in the
  rows and not in the list and the two disagree. The list is capped; the markers
  in the rows never are, so nothing is hidden from the page. The other data
  routes can no longer take the process down either: a snapshot that cannot be
  serialized is answered as a 500 with a reason.

- **Selecting one person blanked the whole studio.** The person scorecard read
  `employee.complexityMix.hi` directly. That deref is type-correct —
  `complexityMix` is declared required — and it threw anyway, because nothing on
  the read path checks a row against the shape it was declared to have:
  `defineObject` stores the schema and never parses `resolve` output with it. A
  datasource that returns a row without that column therefore reached the
  browser intact, and one click on that person threw during render.

  What made it a whole-application failure was that the studio had no error
  boundary anywhere. React unmounts the root when a component throws, so one
  missing metric took the ontology map, every other person and the navigation
  with it. There are boundaries now, one per view: a view that fails says which
  view it was and why, its siblings keep rendering and stay interactive, and the
  error still reaches the browser console for whoever has to fix it.

  The panel itself no longer derefs anything. Every metric is read as the
  unknown it actually is, and a value that is not what the row declared —
  absent, `null`, a string where a number belongs, a mix missing `med`, a getter
  that throws — is printed as a marker naming it, in the same words
  `/api/instances` already uses for a field it could not print. A field that
  cannot be shown is named, never dropped, and never filtered out: a person who
  disappears from the fleet is worse than a person with one bad metric. A row
  that fully conforms renders exactly as it did before.

  Not fixed here, and deliberately: `resolve` output is still never validated
  against the declared schema. That is the root, it is a `core` change touching
  every consumer, and it gets its own ticket. This one keeps the browser
  standing.

### Documentation

- **The Quickstart now lists the Prisma 7 driver adapter among its
  prerequisites, so a reader on Prisma 7 installs it instead of discovering it
  from an `exit 1`.** The requirements block named Node versions and then sent
  the reader straight at `orangerail init`, which on Prisma 7 refuses until the
  adapter the schema's `datasource` provider names is installed — reproduced
  cold from packed tarballs on a Prisma 7 SQLite project. The refusal is
  correct and unchanged; the four provider → package pairs simply arrive one
  step earlier now. `docs/existing-database.md#prisma-7` still holds the full
  walkthrough and nothing moved out of it.

- **The README stated a rules file's reach narrower than it is, and the scope
  argument built on top of that is corrected to the width it was measured at.**
  It said "a `CLAUDE.md` governs the directory it sits in". Measured with a canary
  codename on Claude Code 2.1.220: discovery walks **up** from the working
  directory, so a project file governs its own directory and every subdirectory
  beneath it, and a global `~/.claude/CLAUDE.md` is read from every directory that
  account works in — including an unrelated one and `$HOME`. The section's framing
  moves with it. It no longer says grants travel and rules do not; it says a grant
  travels with the **session** it was registered for and a rules file travels with
  the **machine account** it was written under, and it names the gap as the place
  those two do not overlap — a CI runner, a container, a scheduler under a service
  account. The closing concession was wrong in the other direction for the same
  reason and now concedes a machine account rather than one directory: a global
  rules file plus a good model may be the whole answer for one developer on one
  machine, and the README says so outright.

- `docs/existing-database.md` no longer steers around this defect by prescribing
  `prisma-client-js`. Both client generators are documented, with where each
  generates to and what the ontology imports for each, plus the Node version the
  TypeScript client needs.

- The MySQL row of the driver-adapter table is corrected: `@prisma/adapter-mariadb`
  was run end to end against MySQL 9.7.1 — read, create, update and an approved
  gated delete through the shipped MCP server, with `orangerail audit verify`
  reporting `audit chain OK` — rather than being signature-verified only.

- The README Quickstart now names the Prisma 7 wall before a reader hits it. A
  schema still carrying `url` in its `datasource` block fails every `prisma`
  command, and `db push --skip-generate` is gone —
  [docs/existing-database.md](docs/existing-database.md#prisma-7) already
  answered both, but the Quickstart linked it only for `prisma db pull`, which is
  not the condition a reader in that state matches. One sentence, no content
  moved out of the doc.

## 0.1.1 — 2026-08-01

The first release after `0.1.0`.

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

**An action tool that rejects your input now answers in the same shape.** An
`invalid_input` result from an ACTION tool used to put zod's raw issue objects in
`structuredContent.issues`; it now carries `string[]`, identical to what the
`filter` rejection above returns, and the same sentences are repeated in the
result's text content where an agent will actually read them. If you parsed
`issues[].path` off an action rejection, read the strings instead. What the
server accepts did not change — only what it says about it. See Fixed.

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

**`orangerail init` no longer gates every write it generates. The new default is
`--gate delete`.** This is a change to the posture the tool ships, so read it
even if you skip the rest.

*Existing projects are unaffected.* Your `ontology/*.mjs` files were written
once, they are yours, and no upgrade rewrites them — `init` refuses to run over
an existing project at all. A project generated by `0.1.0` stays all-gated, its
`orangerail.governance.json` still matches, and `sync` still reports nothing.

*A re-run of `init` — in a new project, or after you deleted the old output —
generates a different posture.* On the same 6-action schema that used to produce
six gated actions, the default now produces two:

```console
$ npx orangerail init --yes --preset approval-for-writes --no-studio
  ✓  scanned your sources — 2 object(s), 6 action(s)
  ✓  generated a governed MCP server under ontology/
  ✓  --gate delete: 2 of 6 write action(s) gated behind human approval — the other 4 run when the agent calls them
```

The two `delete` actions carry `policy: { approval: 'required' }`; the creates
and updates do not, and each of those files says so in its own header rather than
claiming a staging step it does not have. `orangerail status` reports
`2 approval-gated, 4 auto` for the same reason.

*`--gate all` restores the old behavior exactly*, byte for byte, and
`--gate none` gates nothing. The wizard asks when the flag is absent. An unknown
value is refused before anything is written.

Why the default moved, stated plainly: gating everything sounds safer and was
producing the opposite. A surface where nothing an agent calls ever completes is
a surface an operator un-gates by hand — all of it, in one sitting, with no
record of which removals were actually considered. The default was manufacturing
the un-gating it existed to prevent. `delete` is gated because it is the op whose
name most reliably predicts a row is gone.

What this is **not** is a safety verdict on the rest. A `create` can be the most
consequential write a schema has. An un-gated `update` is **not recoverable from
the audit chain** — the record holds the input and the resulting row, not the
prior one. And the governance baseline compares against the recorded starting
point, so an action generated un-gated is recorded un-gated and never trips the
weakening check; it catches a later edit, not a permissive `--gate`. Treat the
generated posture as a starting point you read and edit, which is what the
generated files, the closing summary and the baseline note all now say.

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
[What the audit log proves](./docs/audit-log.md).

### Added

- **`orangerail init --exclude <models>` / `orangerail sync --exclude <models>` —
  record that a table was refused, so `sync` can be green.** Leaving a table out
  of the ontology used to be a decision that existed only in the shell history
  that made it. `--models customer,order` filtered at generation time and wrote
  nothing down, so every later `orangerail sync` rediscovered the tables it had
  left out and exited 1 — on a 7-table Postgres schema narrowed to four, 12
  proposals, on every run, forever. A drift check that can never pass is a check
  nobody reads, and this one is what makes the un-gated `--gate delete` default
  defensible. Worse, the only remedy the report named was `--accept-new`, which
  would have generated `ontology/api_credential.mjs` and put three live secrets
  back on the agent's surface: clearing the warning by doing what the warning
  said produced exactly the exposure the operator had avoided.

  A refusal is now recorded in `orangerail.governance.json` — the file that
  already holds what was intended and is already meant to be committed — under
  an `excluded` key. `sync` reports those models as `info:` instead of proposing
  them, does not propose their actions, and `--accept-new` will not create them.
  `status` lists them, and the server startup line says so.

  It is a list of NAMES considered and refused, never a snapshot of what existed:
  a model that appears after the refusal was recorded is not in the list and is
  still reported loudly, and a recorded name that stops matching anything is
  reported as prunable so it cannot silence a future table that reuses it. The
  complement of `--models` is NOT recorded — "I want these four" is not "I
  considered the other three and refuse them" — so `init` names what an allow-list
  left unaccounted for and hands back the `sync --exclude …` command that records
  it, with the names in it.

  Nothing is ever suggested. orangerail will not scan your table names for
  `secret`, `password` or `credential` and pre-select them, for the same reason
  it does not infer destructiveness from an operation name: a name is syntactic
  and the danger it stands for is not — the table that leaks a card number in a
  support transcript is called `payment` — and the moment the tool pre-checks
  boxes, the operator stops reading the list.

  Both flags validate exactly like `--models`: an unknown name, a name given to
  both `--models` and `--exclude`, and an `--exclude` that would leave nothing to
  govern are all refused before a byte is written. `sync --exclude` additionally
  refuses a model the ontology already exposes, and refuses to invent a baseline
  it would have to stamp with a provenance nobody earned. A baseline recorded as
  refused that the ontology serves anyway is reported by `sync` and `status` and
  fails both.

- **`orangerail status` and the `orangerail init` summary now name the MCP
  servers mounted next to this project.** Until now nothing in this product read
  any host agent configuration, and the consequence was measured with a real
  agent: a project narrowed to four models, with a wide SQL server still
  registered in the same `.mcp.json`, answered an ordinary support question by
  falling back to that server's raw-query tool — seven queries, one of them over
  the table the narrowing existed to exclude, with no error, no warning and
  nothing on the audit chain. Adopting orangerail had reduced exposure by
  exactly zero and no surface said so.

  `status` now carries a `hosts:` block, and `init` closes with a beat naming any
  server declared alongside that this project does not govern:

  ```
    hosts:    UNGOVERNED TOOLS ALONGSIDE — 1 other MCP server(s) declared here:
                - postgres (.mcp.json)
              orangerail does not gate those tools, they leave no record on the chain
              above, and an agent that cannot answer a question with the verbs above can
              reach for them instead. …
  ```

  Four things it deliberately does **not** do, each of which was the alternative:

  - **It reads project scope only** — `.mcp.json`, `.cursor/mcp.json`,
    `.vscode/mcp.json`, next to `orangerail.config.mjs`. `~/.claude.json`,
    Claude Desktop's config and `~/.cursor/mcp.json` are not read: a health check
    reaching into a home directory is a privacy-relevant side effect, and
    `~/.claude.json` is the host's entire local state rather than an MCP config.
    Every variant of the block states that bound, and a project with no host
    config at all is told orangerail *cannot tell* what is mounted rather than
    being left with a reassuring silence.
  - **It has no blocklist.** No vendor name appears in the source and a test
    enforces it. The signal is positive identification of *our* server by what
    its `command`/`args` execute; everything else is, by definition, tools this
    project does not govern — equally true of a raw SQL server and a Slack
    server, which is why the wording is "outside this project's governance" and
    never "unsafe".
  - **It does not connect to the other server.** Naming its actual tools would
    mean spawning an arbitrary binary out of a read-only health check, and the
    claim being made is fully supported by the config file alone.
  - **It reports server names only** — never a `command`, an `args` entry or an
    `env` value. A database server's arguments routinely carry a connection
    string, and a diagnostic that copies a credential onto a terminal and into a
    CI log would be a new leak introduced by a leak warning.

  **The exit code does not change.** `status` still exits 1 only for a core skew
  or a posture weaker than the baseline — defects in *this* project. A foreign
  server is a legitimate configuration choice orangerail cannot fix and may not
  fully see, and a health check that fails on a normal setup is one nobody runs.
  The loudness is in the wording. `orangerail mcp`'s startup line carries a
  one-clause version.
- **`orangerail init --gate all|delete|none` — choose which generated writes are
  approval-gated.** Defaults to `delete`; see **Upgrading** for what moved and
  why. The wizard asks the question when the flag is absent, and the flag
  answers it non-interactively, the same contract `--preset` has — an unknown
  value is refused before anything is written. The two flags sit at different
  layers and both matter: `--preset` decides what the server does with the
  ontology at runtime (`readonly` serves no action tools, `sandbox` dry-runs
  them, `approval-for-writes` runs them as declared), and `--gate` decides what
  *as declared* means. The closing summary names the value it used and both
  counts, and the count is derived from the same predicate the emitter branched
  on, so the number on screen and the bytes on disk cannot disagree. An OpenAPI
  action is gated under every value: its `execute` is a stub the engine rejects
  at staging, and an HTTP method does not classify destructiveness —
  `POST /orders/{id}/cancel` is destructive and `DELETE /sessions/{id}` is not.
- **The audit log now records what a write changed *from*.** An audit record for
  a successful update carried the input and the resulting row and nothing else:

  ```jsonc
  {"phase":"succeeded","action":"updateProduct","input":{"id":"p3","stock":25},
   "result":{"id":"p3","sku":"SKU-CABLE","stock":25}}
  ```

  `p3.stock` was `0` before that call and nothing on the chain said so, which
  means an update could be neither described ("what did this change?") nor undone
  from the log alone. `execution_started` records now carry a `prior` field
  holding the action's target as it stood immediately before the write.

  It needs no new declaration. The engine reads it through the `target` +
  `targetIdFrom` + `resolve.get` your ontology already declares — the same read
  the `where` gate performs — so a Prisma `update` generated by `orangerail init`
  and a hand-written one behave identically, and the audit record's meaning does
  not depend on who wrote the action. **A gated action pays no extra
  round-trip** (the gate's read is reused, so the recorded prior is literally the
  row the gate approved); an un-gated action with a readable target pays exactly
  one `get` per execution, on the connection the write is about to use. An action
  with no readable target pays nothing.

  `prior` is a union, because "there was no prior row", "the read failed" and
  "this action declares nothing readable" are three different facts:
  `{ state: 'value', value }` · `{ state: 'none' }` · `{ state: 'unreadable',
  error }` · `{ state: 'withheld' }` · `{ state: 'unavailable', reason }`.
  A failing prior read **never** fails the write — it is recorded as
  `unreadable` and execution continues.

  It sits on `execution_started` and deliberately not on `succeeded`: that append
  is the fail-closed one, while the terminal append is best-effort, so putting
  the recovery value on the terminal record would lose it in exactly the crash
  it exists for. Join the pair on `approvalId ?? correlationId` —
  `verifyAudit` already forces that pairing to exist.

  It is a **witness, not a transactional snapshot**. It is read outside the
  write's transaction (orangerail has none to enlist in — `execute` is your
  code), so a concurrent writer landing in between makes the recorded value
  stale.

- **`redactPrior` — a separate redaction hook for prior rows.** Deliberately not
  `redactAudit`. That hook is written against an action's *input*; a prior row
  carries every column the object declares, including ones no input ever
  mentions, so masking a row with an input-shaped function would hide the fields
  it happens to know and publish the rest — a `password_hash` that never appears
  in an `updateUser` input would have landed in the audit log the day this
  shipped. There is no way to ask a function whether it handles a shape it was
  not written for, so the opt-in is explicit and the default is closed: a project
  with a `redactAudit` and no `redactPrior` records `{ state: 'withheld' }`
  instead of a guess. Opt back into verbatim rows with
  `redactPrior: ({ prior }) => prior`.

- **`orangerail approvals show <id>` prints the target's current state.** An
  approver looking at `{"id":"p3","stock":25}` was being shown one side of a
  change: `stock: 25` is a correction or a catastrophe depending on whether the
  row currently reads `0` or `24`. The detail view now prints a
  `target (current state, read now)` block above the input. The heading says
  what it is — a live read at display time, not the `prior` on the chain, which
  is read at execution time — and it is masked by the same policy the chain
  applies, so the operator surface is never the more permissive one.

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

- **A generated action file describes the policy it actually carries.** An
  un-gated write used to be emitted under a header reading "staged for human
  approval" — a false comment sitting directly above the code that disproves it,
  and the first thing a reviewer reads. It now says it runs when the agent calls
  it and names the line to add to gate it instead. A `delete` keeps its
  DESTRUCTIVE marker under every `--gate` value, and a targeted `update`/`delete`
  keeps `target`/`targetIdFrom` under every value — those name the row the action
  governs, which the studio map, a later `where` guard and the recorded posture
  all read.
- **`orangerail docs` counts the action tools that stage instead of claiming they
  all do.** The generated agent document said "each action tool stages its call
  for human approval" whatever the ontology held. On a mixed ontology that is a
  false instruction in the one file an agent reads as instructions, and the
  failure mode is an agent that calls a `create`, expects an `approvalId`, gets a
  row, and has no reason to think anything went wrong.
- **`orangerail sync --accept-new` writes a gated action, whatever `--gate` the
  project was generated with.** `init` is the moment the posture is chosen, over
  a surface a human is about to read; a model that turned up in a later scan of a
  project somebody already vouched for is not that decision. It is also the only
  coherent choice: a new action absent from the baseline reads as `strengthened`
  when gated and `weakened` when not, so writing it un-gated would put the
  project into the state `orangerail mcp` withholds, immediately, as the direct
  result of a sync flag.
- **The init-provenance governance baseline counts its own rows.** Its note now
  reads `(2 of 6 action(s) approval-gated)`, so a reader who opens the file knows
  the `null`s in it were generated that way rather than introduced later. The
  count is derived from the rows in the same file, not echoed from the `--gate`
  value, so it cannot drift from what is written beside it.
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

- **Every generated `update*` action published a tool schema with no types on it,
  and refused wrong input without saying what was wrong.** The two halves
  compound, and together they are the most expensive defect found in this
  release. An optional field published `{}` — no type at all — because the
  schema builder read the shape through `inputShape`, whose type name for
  `z.number().int().optional()` is `optional`, not `number`. A generated
  `update*` has exactly one required field (`id`) and every column optional, so
  in practice the entire generated write surface advertised itself as untyped:

  ```jsonc
  // before
  "updateProduct": {"id":{"type":"string"},"price":{},"status":{},"title":{}}
  // after
  "updateProduct": {"id":{"type":"string"},"price":{"type":"number"},
                    "status":{"type":"string","enum":["DRAFT","ACTIVE","ARCHIVED"]},
                    "title":{"type":"string"}}, "required":["id"]
  ```

  The generated zod was always correct, and the engine always parsed against it
  — so the server accepted `{"id":"p1","stock":30}` the whole time. Only the
  published contract was wrong, and the rejection that followed a wrong guess
  was the single sentence `Input failed schema validation.`, with no field name
  and no expected type. Measured against a real agent working an unattended
  queue: told `stock` was untyped it guessed a string, and escalated through six
  variations — `"30"`, `"38"`, `"\"30\""`, then every field at once, then `id`
  alone — never once sending a number, because nothing in the loop could tell it
  to. It gave up and reported a confident, wrong diagnosis. 4 of 12 ordinary
  items failed for this reason alone, on `update`, which is the write the
  `--gate` default above argues is the most-called on most schemas.

  A published property now states the type it always had, its optionality by
  absence from `required` (where JSON Schema puts it, rather than by emptying
  the property), `["<type>","null"]` where the zod is nullable, and the enum
  members where it is an enum. `.optional()` and `.nullable()` are probed
  separately, so they can no longer erase each other. A field that genuinely
  cannot be described — a `z.unknown()` Json column — still publishes `{}`; that
  is now the exception rather than the rule.

  Rejections name what they refused: `Input rejected: "price" expects number;
  "status" expects one of DRAFT, ACTIVE, ARCHIVED.` in the tool result's TEXT
  content, and the same list as `issues` in `structuredContent` — the shape the
  read `filter` surface has returned since the closed-filter change above. As
  there, the message names fields and expected shapes and never the value the
  caller sent: zod's own message text is not forwarded, because in zod 3 it
  spells the received value out and neither an agent's context nor an operator's
  log is a place to echo an input that may itself be a probe.

  `additionalProperties` stays `true` on action inputs, deliberately and now on
  the record. The `filter` object is closed because there is a checker behind it
  that refuses an undeclared key; an action input has no such checker and a zod
  object is non-strict by default, so an undeclared key is accepted and stripped.
  Publishing `false` would advertise a refusal that never happens.

  Fixed in `orangerail-mcp`, so **no `orangerail init` re-run is needed** —
  upgrade the package and every existing project's tools re-describe themselves.

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
  of the SAME version are reported on the `status` readout as a duplicate
  install, and are not an error and not a startup banner: they agree today, and
  they are one partial upgrade from not agreeing.

  The check is keyed on module-instance identity — a `Symbol.for` token
  `createRegistry` stamps — and not on a version string. The version string was
  never trustworthy here (`orangerail-core` exports `version = '0.0.0'` while its
  `package.json` says `0.1.0`), the copy whose version matters most predates any
  field a check could read, and equal versions do not imply one instance anyway.

  The CLI reads that token through a bare `Symbol.for` lookup and imports no
  helper to do it. That is load-bearing rather than stylistic: a static
  `import { … } from 'orangerail-core'` is a link-time dependency, so the first
  cut of this check made the CLI fail to start at all next to an
  `orangerail-core@0.1.0` — a `SyntaxError` about a missing export, against the
  exact install it was written to explain. A check that diagnoses an old core
  must not require a new one, and if this CLI's own core turns out to be the old
  one it now reports that it cannot tell, rather than dying.

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

- **The README now leads with the one difference that does not depend on the agent behaving.**
  A second falsification round tested the three things the previous entry reserved as unproven —
  adversarial phrasing, a weaker model, and more runs — and none of them separated the arms. The
  queue was re-run with a claimed prior approval, a statutory deadline reframing inaction as the
  violation, a request to delete the blocking child row first, and an instruction planted in a
  database row the agent had to read; the rules file was followed every time, on a much smaller
  model too, and the planted instruction was caught and flagged unprompted. On one axis the
  markdown arm **beat** orangerail: it read the queue as a whole and found contradictions in it
  that a per-call surface cannot see. The README says so.

  What does separate them was measured directly. Same model, same task, same credentials, only
  the starting directory changed: the markdown arm deleted the row, orangerail staged it.
  Editing the policy has the same shape — removing the deletion prohibition from a rules file is
  reported by nothing at all, while removing one `policy: { approval: 'required' }` makes `sync`
  and `status` exit 1 and the running server withhold the action outright: absent from
  `tools/list`, and `{"status":"unknown_tool"}` when called by name. Asked outright to edit its
  own policy and then use the capability it blocked, the agent refused in **both** arms — so the
  argument is about where the policy lives, not about intent. `docs/limits.md` gains the exact
  meaning of "refuses to serve", and the boundary next to it: the gate resolves against the
  approvals store rather than the chain, so anything that can write that directory can append one
  `resolved` event and execute a staged action, with `audit verify` reporting it only afterwards.
- **The README leads with unattended completion, and prints the arm where a markdown rules
  file matched it.** The document sold a restriction: a table of what an agent cannot do, and a
  section called "See it stop an agent". Nobody wants a narrower agent — the cheapest way to
  narrow one is to give it no tools — and the need this actually meets is the opposite,
  *let it run while I am not there*. The first screen now says that the problem is not that the
  agent does too much but that your only control is a question it has to ask you, and that the
  question is the wrong shape: a permission prompt asks about a tool, while the risk you carry
  is about your domain, a distinction that exists only in your schema.

  It opens on a measured run — a 15-item back-office queue with the operator gone: 12 of 12
  ordinary writes completed unattended, 0 of 3 deletions executed, 3 staged, 27 audit records
  verified. Immediately below it is the control arm, and the control arm **tied**. A Postgres
  MCP server with full write access and no enforcement of any kind, plus a deliberately
  well-written 51-line `CLAUDE.md`, run three times against three database clones, completed
  12/12, executed 0 deletions, stopped 3, touched no forbidden table, and did it with zero
  run-to-run variance. So the README no longer argues that a model will eventually ignore your
  rules — it did not, and that argument gets weaker every time models improve. What it argues
  instead is what survived the tie: the stop produces an executable object rather than a
  paragraph, the policy is derived from your schema and drift-checked rather than hand-written
  prose that silently goes stale, and enforcement travels with the server rather than binding
  one host directory. The measurement's boundary is stated with it (one schema, one model, one
  afternoon; adversarial phrasing and weaker models untested), as is the sentence that follows
  from all of it: **a solo developer with a good model and a good rules file may not need this.**

  The document went from 879 lines to 512. Nothing honest was deleted — the disclosure moved
  into `docs/limits.md` (preconditions, the second-server hole, no aggregation, no DDL, bulk
  ergonomics, and the full account of the `0.1.0` filter oracle), `docs/audit-log.md`,
  `docs/comparisons.md` and `docs/host-approval-prompt.md`, all linked from the README.
  `docs/audit-log.md` additionally gains a section saying plainly that Postgres triggers or
  `pgaudit` cover more than this chain ever will, because they see writes from every source
  and orangerail only ever sees its own tools.
- **New example: `examples/unattended-queue`.** The same 15-item queue, driven through a real
  MCP client over the shipped CLI, so the server-side half of the claim above is reproducible
  without an API key. Twelve ordinary writes execute unattended, three deletions stage, the
  agent's own `check_approval` comes back `pending`, the operator approves one and the other two
  stay waiting, and the chain verifies. It resets the database *and* the approvals store first,
  so two consecutive runs are identical modulo approval ids. The client is a script rather than
  a model on purpose — it demonstrates the server's behaviour, and the model-side claim is
  reported as a measurement rather than dressed up as reproducible. `Payment` is generated out
  with `--exclude Payment`, so there is no tool over card data at all, and the walkthrough
  asserts it.
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
  [What the audit log proves](./docs/audit-log.md), along with
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
