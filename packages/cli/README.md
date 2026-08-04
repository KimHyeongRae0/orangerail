# orangerail

**Decide once what your agent may do. Then leave it working.**

![a back-office queue handed to an agent with nobody watching: ordinary writes finish, a deletion stops and becomes an approval, and the one declared line that stopped it](https://raw.githubusercontent.com/KimHyeongRae0/orangerail/main/examples/unattended-queue/demo.gif)

*`orangerail init`, then one run of a 15-item back-office queue through a real MCP client — no API
key, every line asserted. Twelve ordinary writes finish with the operator gone; three deletions
stop, and what they leave behind is executable tomorrow by someone who was never in the room.*

`orangerail` reads the schema you already have and generates the agent's surface from it. `init`
turns a `prisma/schema.prisma` into an MCP server: a `get` and a `list` per object, one action per
write with a zod input schema, and nothing else — **no `execute_sql`, and nothing on the tool list
that takes a query.**

Writes you are happy to have run unattended run unattended. The ones you are not carry
`policy: { approval: 'required' }`, which stops the call and turns it into an approval a person can
act on later — including a person who is not you, after the conversation that produced it has
ended.

This package is the **operator surface**: the approval queue, the audit and posture readouts, the
scanner that generates the server, and the launcher the agent host spawns.

**Zero runtime third-party dependencies.** Argument parsing is hand-rolled, and the MCP server is
reached through the workspace package `orangerail-mcp`, never a direct SDK dependency. The scanner
makes **no LLM calls and needs no API key** — ever.

## See your whole domain as a map

One command, and the surface `init` generates is a map you can read.

```console
$ orangerail studio
orangerail studio: scanning ontology — 9 object(s), 27 action(s)
orangerail studio: building the interactive map…
orangerail studio: serving on http://127.0.0.1:4820 — open it in your browser
```

Every object, how they relate, and every write action an agent can reach. Hover a table to light up
its relations and actions; click one to read the policy that governs it.

![the orangerail studio map — hovering tables to reveal relations, then opening deleteOrder to read the policy that governs it: target Order, approval required, approvers any, condition none](https://raw.githubusercontent.com/KimHyeongRae0/orangerail/main/assets/studio-map.gif)

*One real run on a sample commerce domain, `--gate delete`. The locks are not annotations added for
the video: they are what the studio draws from your ontology, which is why nine actions carry one
and eighteen do not. It shows you the shape of the domain — it does not let the agent query across
it: there is no traversal tool, no join and no aggregate.*

## Bounded is not safe

A generated surface buys a reach that is *finite and legible*, not a claim that nothing harmful is
inside it. You declared the verbs, so a destructive verb you declared is a verb the agent can call.

**One precondition decides whether this is worth installing: orangerail governs only its own
tools.** If the agent also has a shell with credentials or a second database MCP server, it can go
around the rail —
[what orangerail does not govern](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/limits.md).

## It tied with a rules file

The comparison that matters is not a raw SQL server. It is a well-written `CLAUDE.md` naming the
permitted and forbidden tables, over a Postgres MCP server with full write access. Same queue, same
model, three clones, scored from the database afterwards.

| | markdown rules, full write access | orangerail |
| --- | --- | --- |
| ordinary items completed | 12 / 12, all three runs | 12 / 12 |
| destructive items executed | 0 | 0 |
| what the stop leaves behind | a paragraph in a report | an approval record |
| the same task started in another directory | **row deleted** | staged it |

**It tied on compliance, and it kept tying** — through adversarial rewrites, a fake prior approval,
an instruction planted in a database row, and a much smaller model. On one axis it beat us. So this
project does not argue that your agent will ignore your rules: across every run measured here, it
followed them.

The row that does not tie is the last one. A global `~/.claude/CLAUDE.md` closes most of that gap
for a single developer on one machine — **if that is you, you may not need this.** It stops closing
at a CI runner, a container, a service account, or a teammate's checkout.

[The full comparison](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/vs-a-rules-file.md)
— every run, the axis where the rules file wins, and the limits of the measurement.

## Install

Requires **Node 20 or newer** (`engines.node: ">=20.0.0"`). Install it into the project you are
going to scan:

```bash
npm i -D orangerail
```

`npx -y orangerail` on a project that has not installed it works too, and leaves you with two
copies of `orangerail-core` — one in the npx cache, one in your project — which every later
`orangerail status` reports in a `runtime:` block. Writes still complete under it; it is avoidable,
and installing locally is how.
[Troubleshooting](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/troubleshooting.md).

## Get started

```bash
npm i -D orangerail
npx orangerail init --yes --preset approval-for-writes --no-studio
npm install orangerail-core zod
npm install @prisma/client@6       # match your prisma CLI's major
export DATABASE_URL="file:./dev.db"
npx prisma generate
npx prisma db push --skip-generate # skip if the database already exists
npx orangerail sync --accept-governance   # review + vouch for orangerail.governance.json
npx orangerail status
```

**The `@prisma/client` / `generate` / `db push` lines are not optional decoration.** Without them
the generated actions load fine and the first governed write fails with `the datasource client is
not installed or has never been generated` — *after* the approval has been consumed, so a human
decision is spent and no row changes.

`init` generates `ontology/*.mjs` plus an `orangerail.config.mjs`. Under the default `--gate delete`
it gates every `delete` behind human approval and leaves the other writes executable; `--gate all`
gates every write, `--gate none` gates nothing, and the closing line names which one ran. **The
generated files are yours** — `init` refuses to run again over them, and `sync` reports drift rather
than editing them.

An OpenAPI spec is accepted too and gives you far less: no objects and no read surface at all, just
one `execute: notImplemented` action per non-GET operation to wire up yourself.

No schema file yet, just a live database? `prisma db pull` writes one — see
[adopting orangerail against an existing database](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/existing-database.md),
which also covers what Prisma 7 changes (the generated client needs a driver adapter, and `init`
refuses rather than emitting one that cannot construct).

## Point your agent host at it

`orangerail mcp` is a **stdio** server: the host spawns it, speaks JSON-RPC over its stdin/stdout,
and it dies when the host does. You never start it by hand. `status`, `approvals` and `audit verify`
are ordinary commands you run in your own terminal against the same store while the host's server is
up.

```json
{
  "mcpServers": {
    "orangerail": {
      "type": "stdio",
      "command": "./node_modules/.bin/orangerail",
      "args": ["mcp"],
      "env": { "DATABASE_URL": "file:./dev.db" }
    }
  }
}
```

**That `.mcp.json` is also read back to you.** Whatever else it declares is a set of tools
orangerail does not govern — not gated, not on this project's audit chain, and reachable by the
agent the moment a question the declared verbs cannot answer comes up. `status` names them under
`hosts:`:

```
  hosts:    UNGOVERNED TOOLS ALONGSIDE — 1 other MCP server(s) declared here:
              - postgres (.mcp.json)
```

Read what that claim is and is not. It is **project scope only** — `.mcp.json`, `.cursor/mcp.json`,
`.vscode/mcp.json`, next to your config — so a clean line means "nothing in this repo declares
another server", never "nothing else is mounted"; `~/.claude.json`, Claude Desktop's config and
`~/.cursor/mcp.json` are deliberately not read. It reports **names only**, never a command, argument
or environment value, because a database server's arguments routinely carry a connection string. It
does not connect to the other server, and it does not block, proxy or govern it. And it **exits 0**:
mounting a Slack server next to orangerail is an ordinary choice, and the claim is the narrow one —
those tools are outside this project's governance, not that they are unsafe.

## Commands

```
orangerail init [--yes] [--preset <p>] [--gate all|delete|none]
              [--sources <csv>] [--models <csv>] [--exclude <csv>]
              [--docs|--no-docs] [--studio|--no-studio] [--no-open] [--port <n>]
                                               scan a repo and assemble the ontology
                                               --gate picks which generated actions carry
                                               `policy: { approval: 'required' }`
                                               (default: delete)
                                               --models keeps only those models
                                               --exclude refuses the named ones and records
                                               the refusal, so later scans stop proposing them
                                               --yes implies --no-studio, because nothing that
                                               answers no prompts should be left serving; pass
                                               --studio alongside it to serve anyway
orangerail sync [--config <path>] [--accept-new] [--accept-governance] [--exclude <csv>]
                                               re-scan and report drift
                                               exit 0 nothing to act on / 1 unresolved drift /
                                                    2 could not check
                                               --accept-governance re-records the baseline
                                               --exclude records a proposed model as refused
                                               instead of creating it
orangerail mcp [--config <path>]               launch the MCP server over stdio
                                               (withholds actions weaker than the baseline)
orangerail status [--config <path>]            show the governance posture (exit 1 on drift)
                                               plus any MCP server mounted alongside that
                                               this project does not govern (never exit 1)
orangerail studio [--config <path>] [--port <n>] [--no-open]
                                               serve the read-only domain map locally
orangerail docs [--config <path>] [--out <dir>]
                                               generate the agent-facing domain doc
orangerail approvals list [--config <path>]    list pending approvals
orangerail approvals show <id> [--full] [--config <path>]
                                               show one approval (--full: uncapped input)
orangerail approvals approve <id> [--config …] approve a staged action (CAS)
orangerail approvals reject <id> [--config …]  reject a staged action (CAS)
orangerail audit verify [--config <path>]      verify the audit chain
orangerail store unlock [--config <path>]      clear a provably-dead store lock

--help, -h     print this usage (accepted anywhere, e.g. `orangerail init --help`)
--version, -v  print the CLI version
```

Exit codes: `0` clean, `1` a finding the command exists to report (drift, a broken chain), `2` an
error. An unrecognized flag is a hard error naming the valid set — it is never silently ignored,
because `orangerail status --confg /path/to/prod` reporting a confident green result for the *local*
project is worse than no report.

## The approval display

`approvals list` renders the approver decision surface: full id, action, `requestedBy` (with a
`[dev]` marker in dev mode), age, and a one-line input preview. Every agent-supplied string is
stripped of ANSI/control characters and JSON-escaped before it reaches the terminal
(approval-deception defense) — the staged input is always labeled agent-supplied. Bidi and
invisible-formatting code points (`U+202E` and the rest of the Trojan Source class, the zero-width
characters, the TAG block) are escaped to a visible `\uXXXX` rather than deleted, so a hostile
string can neither reorder the line nor pass as a clean one.

`approvals show` caps the staged input so the decision context (`id`, `action`, `status`,
`requestedBy`) always stays on screen — a 1 MB input would otherwise scroll it away. The truncation
states exactly how much was withheld; pass `--full` to print the whole value.

## Governance drift

`orangerail sync` re-scans your sources and reports drift, and it also reviews the **governance
posture** — something the scan structurally cannot do, because the scanner has no opinion on policy.
The posture is read from the live registry and compared against `orangerail.governance.json`, the
baseline `init` records and `sync --accept-governance` re-records.

**Commit that file.** Its whole value is that a pull request removing an approval gate shows
`"approval": "required"` turning into `null` in its own diff, in front of a reviewer, before CI
runs.

The baseline records **who wrote it**. `"recordedBy": "init"` is the posture init generated, before
anyone reviewed it — a starting point, not an approval, and every `sync` and `status` says so until
you run `--accept-governance`, which stamps it `"recordedBy": "sync"`. A file written before this
field existed reads as `"sync"`, since only `--accept-governance` could have written it.

When the posture *weakens* — a gate removed, a `where` guard removed or rewritten, approver roles
widened, an action retargeted, or a new action that is not gated — `sync` exits 1, `status` exits 1,
and **`orangerail mcp` withholds that action**: it is absent from `tools/list` and the engine will
not resolve it by name, so it cannot be staged or executed. Everything else is served. A tightening
is reported quietly and changes nothing.

Deliberate behaviors worth knowing:

- A project with at least one action and **no** baseline exits 1 from `sync` until you record one.
  The server still starts; it says the posture is unverified.
- A missing or unreadable baseline never stops the server. Deleting the file is always available, so
  failing closed on a corrupt one would buy nothing and cost you a server over a typo.
- A **functional** `where` predicate records as the constant `functional`, so a rewrite of its body
  is invisible to the diff. `sync` states that limit in its own output rather than implying coverage
  it does not have.

## Configuration

Every command loads an ontology config — a default export
`{ registry, store, resolveIdentity?, preset?, redactAudit?, redactPrior?, allowDevMode? }` — from
`orangerail.config.mjs` (or `.js`, `.ts`, `.mts`, or `--config <path>`) via plain dynamic `import()`.
TypeScript configs work through your own TS-capable runtime (`tsx`, or
`node --experimental-strip-types`); orangerail does not bundle a loader. Every command discovers the
same four names, `init` included — it refuses rather than regenerate over an ontology whose config
is a `.ts`.

Loading a config is **arbitrary code execution** (same trust level as an npm script) — run only
configs you trust.

## Identity and dev mode

`approve` / `reject` resolve the caller with
`resolveCaller({ transport: 'cli', request: { osUser } })`. A config `resolveIdentity` adapter maps
the OS user to `{ subject, roles }` (role mapping lives in the config). With no adapter the local
CLI runs in **dev mode**: the `local-dev` identity approves anything and stamps `devMode: true` into
audit records.

## Where the store lives

`init` scaffolds the approval and audit store **inside the project it just scanned** — the generated
config builds it as `createFileStore({ dir: join(here, '.orangerail', 'store') })`. That is right
for a local single-user run and wrong the moment the governed agent also has file tools over that
repo, because the agent can then write the very log that records what it did.

There is no CLI flag for this. The location is the `dir` argument of `createFileStore` in your own
`orangerail.config.mjs`, which orangerail never regenerates, so relocating the store is a one-line
edit:

```js
const store = createFileStore({ dir: '/var/lib/orangerail/store' });
```

Point it somewhere the agent's tools cannot reach. The audit log's guarantees, and their limits, are
stated exactly under
[What the audit log proves](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/audit-log.md).

## Store lock recovery

If a process died inside the file store's critical section, the store stays locked (the runtime
never steals a lock). Run `orangerail store unlock` when no orangerail process is running — it
clears the lock only when the owner pid is provably dead, and refuses a live/ambiguous owner or a
missing `owner.json`. As a last resort, `rm -r <store-dir>/lock` while no orangerail process runs.

## Storage warning

Approvals and audit records store action inputs — and audit records also results, error messages,
and the target's **prior state** — in plaintext by default. Supply `redactAudit` in the config to
mask audit-record inputs (approval records persist verbatim by design), and `redactPrior` to mask
prior rows. They are separate hooks because a row carries columns no input mentions, so an
input-shaped mask would publish them: configure `redactAudit` alone and prior rows are withheld
instead. **Do not put secrets in action inputs.**

`orangerail approvals show <id>` prints the target's current state above the staged input, so an
approver sees both sides of the change. It is a live read at display time, masked by the same policy
the audit chain applies.

## Upgrading from 0.1.0

Two things an upgrade asks of you. The full list is in the
[CHANGELOG](https://github.com/KimHyeongRae0/orangerail/blob/main/CHANGELOG.md).

- **Re-stage any approval that was still `pending`.** An approval created by `0.1.0` carries no
  `inputHash`, so `execute` cannot bind the payload to the approval and refuses: the call returns
  `{ status: 'invalidated', reason: 'input' }` and the approval is spent. Ask the agent to call the
  tool again. Existing audit chains verify unchanged, and a missing hash is never reported as
  tampering.
- **Run `orangerail sync --accept-governance` once, and commit the file.** Until you do, a project
  with at least one action exits 1 with `governance: no recorded baseline`. That first red run is
  intentional. Your server keeps starting in the meantime — it just reports that it cannot verify
  the posture it is enforcing.

## Docs

The full story, with real recorded output and a walkthrough you can run, is in the
[project README](https://github.com/KimHyeongRae0/orangerail#readme).

- [What orangerail does not govern](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/limits.md)
- [What the audit log proves](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/audit-log.md)
- [Against the thing you would do instead](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/vs-a-rules-file.md)
- [How orangerail compares](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/comparisons.md)
- [Wire it into your agent host](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/agent-hosts.md)
- [Troubleshooting](https://github.com/KimHyeongRae0/orangerail/blob/main/docs/troubleshooting.md)

## License

[MIT](https://github.com/KimHyeongRae0/orangerail/blob/main/LICENSE)
