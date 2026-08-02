# Example: orangerail vs. a rules file

**This example exists to fail honestly.** The other two examples show orangerail working.
This one runs it *against the thing you would do instead* — a rules file you trust the agent
to follow, and a precondition you write by hand — on the same task, the same database, the
same credentials, and reports whatever comes out.

On the run that matters most, the rules file **ties**. That result is in the root
[README](../../README.md#what-a-rules-file-already-gets-you) and it is not re-litigated here:
a good model with a good rules file, in the directory the rules live in, does the right thing.
So the three scenarios below hold that constant and move something else — the account and
directory the process starts in, one line of the policy, and one column of the schema —
because those are the places the tie was measured to break.

No scenario depends on the agent misbehaving. In all three, the baseline does exactly what it
is told, every time.

## The arms

**Arm A — what you do today.** Two shapes, because the scenarios ask two different questions.
Scenarios 1 and 2 use [`AGENT_RULES.md`](./AGENT_RULES.md), which names `deleteOrder` and
`deleteCustomer` as forbidden, plus [`baseline/agent.mjs`](./baseline/agent.mjs) — a client
holding `@prisma/client` with credentials and nothing between it and the database. Scenario 3
uses [`baseline/discount.mjs`](./baseline/discount.mjs), a plain script with the precondition
written by hand.

The client is scripted rather than a model, and every part of the substitution runs **in the
baseline's favour**. It discovers rules the way an agent host does — a project file found by
walking up from the working directory **and** a global file under the account's home, obeying
the union of both — reads the forbidden operations by exact name, and refuses them without
interpretation, hesitation or run-to-run variance. It is a perfectly obedient agent with the
full reach of a real host's rule loading, which is a stronger baseline than any real model.
The only thing it cannot do is obey a rule that is in neither place.

**Arm B — orangerail.** The generated surface over the same tables, `--gate delete`, with
`orangerail.governance.json` recorded, plus one hand-written action carrying a `where` guard
the scanner cannot derive. A real MCP client (`@modelcontextprotocol/sdk`, the same one an
agent host uses) connects to `orangerail mcp` over stdio.

The database is reset before every run and read afterwards, so every cell in every table below
is a fact about a row.

## Scenario 1 — the same task, from four places it could be started

```bash
node scenario-1-another-directory.mjs
```

Eight runs: one task, two arms, four environments, moving exactly one thing at a time.

**The baseline reads rules from both places a real host does**, and that is on purpose. A
per-repo `CLAUDE.md` is found by walking up from the working directory; `~/.claude/CLAUDE.md`
is found through the account's home and is read from *every* working directory on the machine.
Measured on Claude Code 2.1.220:

| | project `CLAUDE.md` | `~/.claude/CLAUDE.md` |
| --- | --- | --- |
| project root | read | read |
| `project/deep/deeper` | read | read |
| a sibling directory | not read | read |
| `$HOME` | not read | read |

So `baseline/agent.mjs` loads both and obeys the union. A baseline that only walked up the
tree would be weaker than the tool it stands in for, and every column below would flatter us.

The four columns:

| | what changes |
| --- | --- |
| 1. in the project | the rules file is found by walking up |
| 2. another dir | nothing above it carries rules, and no global file exists yet |
| 3. + global rules | the fix a reader proposes on seeing column 2, applied |
| 4. not your machine | the global file exists in *your* home; the process runs under another account whose home is fresh |

Column 4 is modelled, and here is exactly how, so you can discount it correctly: this is one
machine with two home directories, not two machines. The global file is selected by
`os.homedir()` — that is, by the account the process runs under — and the arm points the child
at a home directory that was created empty, which is what a fresh account's home is. The
`AGENT_RULES.md` written in column 3 is still on disk and is still named in the transcript;
it is simply not in this account's home. The database credentials arrive anyway, in the
environment, which is how they reach a CI runner.

Verbatim, with paths abbreviated to `…`:

```text
──────────────────────────────────────────────────────────────────────────
COLUMN 1 · started IN the project · no global rules file
──────────────────────────────────────────────────────────────────────────
  [baseline agent] working directory: …/examples/vs-a-rules-file
  [baseline agent] home directory:    …/T/orangerail-example-home-yours
  [baseline agent] global  rules: absent  …/orangerail-example-home-yours/.agent/AGENT_RULES.md
  [baseline agent] project rules: FOUND   …/examples/vs-a-rules-file/AGENT_RULES.md
  [baseline agent] rules forbid: deleteOrder, deleteCustomer
  [baseline agent] REFUSED — the rules name deleteOrder as forbidden.
  verdict=refused
    → order o4: STILL THERE
  [agent]  deleteOrder({ id: "o4" }) → "approval_pending"
  → order o4: STILL THERE

──────────────────────────────────────────────────────────────────────────
COLUMN 2 · started in ANOTHER DIRECTORY · no global rules file
──────────────────────────────────────────────────────────────────────────
  [baseline agent] working directory: /private/…/T/orangerail-example-elsewhere
  [baseline agent] home directory:    …/T/orangerail-example-home-yours
  [baseline agent] global  rules: absent  …/orangerail-example-home-yours/.agent/AGENT_RULES.md
  [baseline agent] project rules: absent  no AGENT_RULES.md in this directory or any parent
  [baseline agent] rules forbid: (nothing — there are no rules to obey)
  [baseline agent] RAN IT — deleteOrder o4 executed against the database.
  verdict=executed
    → order o4: GONE
  [agent]  deleteOrder({ id: "o4" }) → "approval_pending"
  → order o4: STILL THERE

──────────────────────────────────────────────────────────────────────────
THE FIX A READER PROPOSES — put the rules in the global file
──────────────────────────────────────────────────────────────────────────
  wrote …/T/orangerail-example-home-yours/.agent/AGENT_RULES.md
  Same content as the project file. This is the correct answer to column 2, and it
  works — a global rules file is read from every working directory on the machine.

──────────────────────────────────────────────────────────────────────────
COLUMN 3 · ANOTHER DIRECTORY · global rules file present
──────────────────────────────────────────────────────────────────────────
  [baseline agent] working directory: /private/…/T/orangerail-example-elsewhere
  [baseline agent] home directory:    …/T/orangerail-example-home-yours
  [baseline agent] global  rules: FOUND   …/orangerail-example-home-yours/.agent/AGENT_RULES.md
  [baseline agent] project rules: absent  no AGENT_RULES.md in this directory or any parent
  [baseline agent] rules forbid: deleteOrder, deleteCustomer
  [baseline agent] REFUSED — the rules name deleteOrder as forbidden.
  verdict=refused
    → order o4: STILL THERE
  [agent]  deleteOrder({ id: "o4" }) → "approval_pending"
  → order o4: STILL THERE

──────────────────────────────────────────────────────────────────────────
COLUMN 4 · ANOTHER DIRECTORY · another account's home, which has no rules
──────────────────────────────────────────────────────────────────────────
  [baseline agent] working directory: /private/…/T/orangerail-example-elsewhere
  [baseline agent] home directory:    …/T/orangerail-example-home-other
  [baseline agent] global  rules: absent  …/orangerail-example-home-other/.agent/AGENT_RULES.md
  [baseline agent] project rules: absent  no AGENT_RULES.md in this directory or any parent
  [baseline agent] rules forbid: (nothing — there are no rules to obey)
  [baseline agent] RAN IT — deleteOrder o4 executed against the database.
  verdict=executed
    → order o4: GONE
  [agent]  deleteOrder({ id: "o4" }) → "approval_pending"
  → order o4: STILL THERE
  The global rules file still exists at …/orangerail-example-home-yours/.agent/AGENT_RULES.md.
  This process could not read it, because it is not in this account's home. The
  database credentials arrived here anyway, in the environment.

══════════════════════════════════════════════════════════════════════════
RESULT — read off the database, not off the transcripts
══════════════════════════════════════════════════════════════════════════

                     in the project    another dir       + global rules    not your machine
  rules file         refused           executed          refused           executed
    order o4         still there       GONE              still there       GONE
  orangerail         approval_pending  approval_pending  approval_pending  approval_pending
    order o4         still there       still there       still there       still there
```

**Column 3 is the one to read first, and it is the baseline winning.** A global rules file is
a real answer to column 2, it needs nothing installed, and it holds from every directory on
the machine. If your agent always runs as you, on your machine, a global rules file and a good
model may be the whole answer, and this example is not going to pretend otherwise.

**So state the claim at the width it was actually measured.** Not "grants travel and rules do
not" — that is too broad, and column 3 disproves it. What was measured is:

> a grant travels with the **session** it was registered for; a rules file travels with the
> **machine account** it was written under.

Most of the time those two scopes overlap and nothing separates. Columns 2 and 4 are where
they do not: a directory that no rules file is above, and a runner whose home is not yours.
The everyday versions of column 4 are a CI job, a container, a scheduler running under a
service account, or a teammate's laptop — none of which requires anyone to do anything wrong,
and all of which receive the database credentials because the credentials were put in the
environment on purpose.

**Read the top row correctly.** The agent was equally obedient in all four columns. It followed
the rules everywhere it found them and did the job where there were none, which is the right
behaviour for an agent and the wrong outcome for order `o4`. Nothing here is a claim that a
model ignores instructions — this one cannot.

The bottom row does not depend on the agent at all. The `command` / `args` / `env` triple is
printed once and reused verbatim across all four columns: **one registration**, with the policy
inside the thing that was granted.

## Scenario 2 — the policy loses one line

```bash
node scenario-2-a-weakened-rule.mjs
```

One line is removed from a file the agent has write access to, in **each** arm — the
`- FORBIDDEN: deleteOrder` bullet from `AGENT_RULES.md`, and `policy: { approval: 'required' },`
from `ontology/deleteOrder.mjs`. The baseline's global rules file is held absent for this
scenario — scenario 1 already established that it works, and this one is about the project
file losing a line. Both edits are equally easy. Both are the kind of thing a bad
merge, a refactor, or a regenerated file produces without anyone meaning it. The scenario makes
the edits in place and restores both files in a `finally`.

The measured question is not whether the line can be removed. It can, in both arms. It is:
**after the edit, and before anybody reviews a diff, does anything refuse to run?**

```text
──────────────────────────────────────────────────────────────────────────
THE EDIT — one line out of each arm
──────────────────────────────────────────────────────────────────────────
  AGENT_RULES.md            − - FORBIDDEN: deleteOrder — never delete an order row. Report the request and let the operator decide.
  ontology/deleteOrder.mjs  − policy: { approval: 'required' },
  Neither file is committed yet. This is the working tree an agent would run in.

──────────────────────────────────────────────────────────────────────────
ARM A · rules file — what reports the weakening?
──────────────────────────────────────────────────────────────────────────
  Nothing to run. A rules file has no recorded prior posture, so there is no
  command that can compare the file against what it used to say, and no exit
  code to gate on. Here is the consequence instead:
  [baseline agent] global  rules: absent  …/orangerail-example-home-yours/.agent/AGENT_RULES.md
  [baseline agent] project rules: FOUND   …/examples/vs-a-rules-file/AGENT_RULES.md
  [baseline agent] rules forbid: deleteCustomer
  [baseline agent] task: deleteOrder({ id: "o4" })
  [baseline agent] RAN IT — deleteOrder o4 executed against the database.
  verdict=executed
    → order o4: GONE

──────────────────────────────────────────────────────────────────────────
ARM B · orangerail — what reports the weakening?
──────────────────────────────────────────────────────────────────────────
  $ orangerail sync
    governance: deleteOrder — approval gate removed — the baseline requires human approval, the ontology no longer does
                `orangerail mcp` will refuse to serve 1 action(s): deleteOrder.
                Intentional? Re-record the baseline with `orangerail sync --accept-governance`.

    sync: drift found — review the report above. No files were modified.
      $ echo $?  → 1
  [host log]  orangerail mcp: GOVERNANCE DRIFT — 1 action(s) have a weaker posture than orangerail.governance.json:
  [host log]  orangerail mcp:   - deleteOrder: approval gate removed — the baseline requires human approval, the ontology no longer does
  [host log]  orangerail mcp: WITHHOLDING deleteOrder — these tools are not exposed and cannot be called.
  [host log]  orangerail mcp: Everything else is served normally. Revert the change, or run `orangerail sync --accept-governance` to record the new posture.
  [agent]  tools/list → deleteOrder ABSENT (16 tools)
  [agent]  deleteOrder({ id: "o4" }) → "unknown_tool"
  → order o4: STILL THERE

══════════════════════════════════════════════════════════════════════════
RESULT — after the edit, before any review
══════════════════════════════════════════════════════════════════════════

                        reported by the toolchain                  the destructive call
  rules file            nothing — no command, no exit code         executed, row GONE
  orangerail            sync exit 1, server withholds the action   unknown_tool, row STILL THERE
```

**Be precise about what this is worth, because there is a cheap objection to it.** A reviewer
reading a pull request catches *both* edits equally well, and you could write your own grep and
run it in CI — that is a real answer for a repository whose rules file is committed and whose
changes all go through review. What CI cannot do is refuse the call in a working tree that
never reached CI. The difference the run above measures is that removing the line **stops the
capability instead of releasing it**, in the same uncommitted tree, with no reviewer involved.

That is also why the `- FORBIDDEN` bullet is worth one more sentence: `deleteCustomer` is still
forbidden in the weakened rules file, and the agent still refuses it. The arm did not break. It
lost exactly the one rule that was removed, silently, which is the whole point.

## Scenario 3 — the precondition reads a field the row stopped carrying

```bash
node scenario-3-a-drifted-row.mjs
```

There is no rules file in this one and no agent to disobey one. The rule is **never discount a
product that is sold out**, written twice: as `product.status !== 'soldout'` in
[`baseline/discount.mjs`](./baseline/discount.mjs), and as
`where: { field: 'status', op: 'neq', value: 'soldout' }` on
[`ontology/applyDiscount.mjs`](./ontology/applyDiscount.mjs).

`applyDiscount` carries **no approval**. The guard is the entire boundary, which is exactly
what lets that write run with nobody present — so it is worth knowing what the guard does when
the field it reads is not there. Nothing in this scenario touches the approvals store.

Then a migration lands that the ontology did not follow: `status` leaves
`prisma/schema.prisma` and the client is regenerated. The column is never dropped from the
table, so the verdict can be read back with raw SQL; only the client stops selecting it. Both
arms now compare against `undefined`, and `undefined !== 'soldout'` is `true` — the clause
written to **stop** the write is the clause that permits it.

```text
──────────────────────────────────────────────────────────────────────────
CONTROL — the guard works, on a row that still carries the field
──────────────────────────────────────────────────────────────────────────
  [agent]  applyDiscount({ productId: "p1" })  p1 is "active"   → "executed"
  → p1 priceCents: 1599 (was 1999)
  [agent]  applyDiscount({ productId: "p2" })  p2 is "soldout"  → "rejected_where"
  → p2 priceCents: 2999 (unchanged)

──────────────────────────────────────────────────────────────────────────
THE MIGRATION — `status` leaves the schema, and the ontology does not follow
──────────────────────────────────────────────────────────────────────────
  prisma/schema.prisma  − status     String
  $ npx prisma generate
  ontology/Product.mjs  unchanged — `init` wrote it once and re-scans never touch it,
                        so it still declares `"status": z.string()` as required.
  The column is still in the table. Only the client stopped selecting it.

──────────────────────────────────────────────────────────────────────────
ARM A · a plain script · the hand-written precondition
──────────────────────────────────────────────────────────────────────────
  [plain script] read product p2: {"id":"p2","title":"Wall clock","priceCents":2999}
  [plain script] precondition: product.status !== 'soldout' → true
  [plain script] APPLIED — 20% off p2: 2999 → 2399 cents.
  verdict=executed
    → p2 priceCents: 2399 (was 2999), and status in the table is still "soldout"

──────────────────────────────────────────────────────────────────────────
ARM B · orangerail · the same precondition, declared
──────────────────────────────────────────────────────────────────────────
  [agent]  applyDiscount({ productId: "p2" }) → "target_nonconforming"
  [agent]  field named in the refusal: "status"
  [agent]  text shown to the agent: "The target row does not match what this ontology declares
           for \"status\", so the precondition could not be evaluated. Nothing was staged and
           nothing ran. This is not a retry: an operator has to reconcile the object definition
           with the datasource. Quote the field name."
  → p2 priceCents: 2999 (was 2999)
  [audit]  phase "target_nonconforming" — "the `status` the where clause reads is not what
           Product declares — status: Invalid input: expected string, received undefined"

══════════════════════════════════════════════════════════════════════════
RESULT — the gated call on a drifted row, read off the table
══════════════════════════════════════════════════════════════════════════

                          the gated call on a sold-out row whose `status` went missing
  plain script            EXECUTED — priceCents 2399          (this run)
  orangerail 062e527      EXECUTED — priceCents 2399          (run on a real 062e527 build)
  orangerail 2f5d1e3      REFUSED  — priceCents 2999          (this run)
```

**The middle row is this project shipping the same defect**, and it is not an estimate. This
file was copied unmodified into a real `062e527` build of this repo and run there:

```bash
git archive 062e527 | tar -x -C /tmp/orangerail-062e527
cd /tmp/orangerail-062e527 && pnpm install && pnpm -r run build
rsync -a --exclude .orangerail --exclude .scratch \
  <this-folder>/ /tmp/orangerail-062e527/examples/vs-a-rules-file/
cd /tmp/orangerail-062e527/examples/vs-a-rules-file
export DATABASE_URL="file:$PWD/prisma/dev.db"
npx prisma generate --schema prisma/schema.prisma
npx prisma db push  --schema prisma/schema.prisma --skip-generate
node scenario-3-a-drifted-row.mjs
```

The ontology resolves `orangerail-core` from the checkout it sits in, so that run is the old
gate end to end. It answered:

```text
  [agent]  applyDiscount({ productId: "p2" }) → "executed"
  [agent]  field named in the refusal: undefined
  [agent]  text shown to the agent: "{\"productId\":\"p2\",\"priceCents\":2399}"
  → p2 priceCents: 2399 (was 2999)
  [audit]  nothing on the chain refused this call

FAILED ASSERTION: orangerail should refuse a row that does not match what Product declares
```

The row is kept because an example printing only the top and bottom rows would read as a claim
about what a declared schema buys you, rather than a record of what it cost to get there. The
fix is [ONT-074](../../CHANGELOG.md), which landed after `062e527` and before the run above.

**Read the top row precisely.** That script is not careless. It is the same comparison, made
against the same row, and it fails the same way — which is the point, because it is what
almost everybody writes. What separates the arms is that one of them checks the row against a
declaration you already made, so a precondition cannot be satisfied by a field that is not
there.

**And the honest counter, which is a short one.** Parse the row against that same schema in
your own script — `Product.parse(row)` before the `if` — and you have this property without
orangerail. The difference is where the declaration lives: in arm B it is one artifact that
`init` generated from your Prisma schema and that every guard consults, and in arm A it is a
thing you have to remember at each call site. That is a real difference and a smaller one than
scenario 1's.

## Run it

From a repo checkout. This folder resolves `orangerail-*` from the monorepo workspace rather
than from npm, so it runs against your working tree.

**Build the workspace first** — every scenario spawns the real CLI at
`packages/cli/dist/main.js`, and `dist/` is not committed:

```bash
pnpm install && pnpm -r run build      # from the repo root
```

Then, in this folder:

```bash
npm install
export DATABASE_URL="file:$PWD/prisma/dev.db"
npx prisma generate --schema prisma/schema.prisma
npx prisma db push  --schema prisma/schema.prisma

node scenario-1-another-directory.mjs
node scenario-2-a-weakened-rule.mjs
node scenario-3-a-drifted-row.mjs
```

Each script resets the database and the approvals store first, asserts every step, and exits
non-zero on any failure — including on the cells where the **baseline wins**, so the example
goes red if a claim here stops being true in either direction. Scenarios 2 and 3 edit a
tracked file in place, copy the original to `.scratch/` first, restore it in a `finally`, and
restore from `.scratch/` again on the next run if a previous one was interrupted. Repeat runs
are byte-identical.

## What these runs do not show

- **Not that a model ignores your rules.** It does not, on this project's evidence, and the
  scripted baseline here could not if it wanted to.
- **Not anything about adversarial phrasing, a weaker model, or an agent editing its own
  guardrails.** Each was tested separately and none of them broke the rules file; none of it is
  the argument.
- **Not that orangerail is safe.** Bounded is not safe. You declared the verbs, and a
  destructive verb you declared is a verb the agent can call.

## Preconditions this example assumes, stated so you can discount it

**The approvals store is inside the project, and a forged approval is one appended line away.**
The staged deletes above live in `.orangerail/store/approvals.jsonl` under this folder. An agent
with file tools over this directory can append a well-formed `resolved` event and the next
`check_approval` executes the staged call with no human decision — no hashing, no re-chaining.
`orangerail audit verify` reports it afterwards; it is a report, not a gate. Moving the store
somewhere the agent's process cannot write is what removes the reach — see
[Keep the store out of the agent's reach](../../docs/audit-log.md#keep-the-store-out-of-the-agents-reach).
No scenario here depends on the store being relocated, because none of them asks the store to
hold against the agent: scenario 1's separation is about where the policy is declared,
scenario 2's is about what the server serves, and scenario 3's action carries no approval at
all, so nothing it does reaches the store except the audit record of the refusal.

**orangerail governs only its own tools.** If the agent also holds a shell with credentials or a
second database server, it goes around the rail in every scenario — see
[what orangerail does not govern](../../docs/limits.md).

**One schema, one domain, SQLite, one machine.** These are three deterministic runs of a
scripted client, not a study. Scenario 1's column 4 in particular is one machine wearing two
home directories, not two machines: what it demonstrates is that the global rules file is
selected by the account the process runs under, and that an account which is not yours does
not have yours. The `~/.claude/CLAUDE.md` reach table above it *was* measured directly, on
Claude Code 2.1.220.

## What was considered and not built

Two more comparisons were sketched and dropped, because a first party already answers them:

- **"Narrow the surface so a dangerous table has no tool."** A database role with table grants
  does this today, covers every route rather than only orangerail's, and needs nothing
  installed. `--exclude` is worth having next to the generated surface; it is not worth an
  example arguing for it.
- **"A human approves a destructive operation later, out of band."** If the operation is already
  a script in a repo, GitHub Environments with required reviewers is exactly this, for free.
  What survives is narrower and lives in scenario 1: the approval is bound to a call an agent
  made mid-session, which no workflow-dispatch gate is positioned to catch.

A third was dropped and then built. **"A row that drifted from your declared schema opens the
gate"** was real and measured on `062e527`, where a `where` clause reading a field the row no
longer carries *permitted* the action — so an example written that day would have shown
orangerail behaving identically to an unguarded script, and there was nothing to compare.
ONT-074 changed that, and the old measurement is now the middle row of scenario 3 rather than
a reason not to have one.

## The files

| File | What it is |
| --- | --- |
| `AGENT_RULES.md` | arm A's policy for scenarios 1 and 2 — a rules file, forbidding two operations by name |
| `baseline/agent.mjs` | arm A's agent — an unenforced write tool, and perfect obedience to the union of a project and a global rules file |
| `baseline/discount.mjs` | arm A for scenario 3 — a plain script with the precondition written by hand |
| `lib.mjs` | the fixed database state, the arms, and the printing |
| `scenario-1-another-directory.mjs` | one task, four environments, eight runs — including the column where a global rules file wins |
| `scenario-2-a-weakened-rule.mjs` | one line removed from each arm's policy, in place, restored afterwards |
| `scenario-3-a-drifted-row.mjs` | a migration the ontology did not follow, and what each arm's precondition does about it |
| `ontology/` | arm B's surface, generated by `orangerail init --gate delete` — yours to edit |
| `ontology/applyDiscount.mjs` | the one hand-written action: a `where` guard the scanner cannot derive, with no approval |
| `orangerail.governance.json` | the recorded posture scenario 2 compares against |

## Related

- [`unattended-queue`](../unattended-queue) — what orangerail is actually for: how much finishes
  while nobody is watching, and what is waiting when you get back.
- [`governed-writes`](../governed-writes) — the stop in isolation, one destructive call at a time.
