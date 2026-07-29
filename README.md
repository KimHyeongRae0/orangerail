# orangerail

> Generate a typed MCP surface from the schema you already have — a tool per entity, a tool
> per write, and a human gate on the writes that need one.

`orangerail init` reads your `prisma/schema.prisma` or OpenAPI spec and generates an MCP
server from it: a `get` and a `list` tool per object, one action per write with a zod input
schema, and nothing else. It is a scanner and a code generator — no LLM calls, no API keys,
and the generated files under `ontology/` are yours to edit. An agent pointed at it gets a
fixed set of typed tools rather than an `execute_sql` box and a schema dump. The writes you
do not want run unattended carry `policy: { approval: 'required' }`, which stages the call for
a person instead of executing it, and `orangerail mcp` withholds an action whose gate has
since been weakened against the baseline it recorded.

One precondition, up front, because it decides whether any of this is worth installing:
**orangerail governs only its own tools.** If the agent also has a shell with credentials or
a second database MCP server, it can go around the rail — see
[What orangerail does not govern](#what-orangerail-does-not-govern).

**Status: pre-release, and installable.** v0 is on npm at `0.1.0` — `orangerail` (the
CLI) plus `orangerail-core`, `orangerail-mcp`, `orangerail-docs-gen` and
`orangerail-studio`. `npx orangerail init` runs against your own project today, with no
checkout of this repo ([Quickstart](#quickstart)). It is still v0 and under active
development: the API described further down is the design target, and it will move before
1.0. What has changed since `0.1.0`, and the one thing an upgrade asks of you, are in the
[CHANGELOG](./CHANGELOG.md).

## What the agent gets instead of `execute_sql`

Point an agent at a general-purpose database MCP server and the surface is usually two tools:
dump the schema, then send a SQL string. Every call is an unconstrained string, and the server
has no opinion about any of it.

orangerail generates the surface from the schema instead. Run `orangerail init` on a
three-model Prisma schema (`Order`, `OrderItem`, `Payment`) and this is the entire tool list —
copied from the `orangerail docs` output for that generated project:

```text
| Tool | Kind | Backing entity |
| --- | --- | --- |
| `Order_get` | read (get) | Order |
| `Order_list` | read (list) | Order |
| `OrderItem_get` | read (get) | OrderItem |
| `OrderItem_list` | read (list) | OrderItem |
| `Payment_get` | read (get) | Payment |
| `Payment_list` | read (list) | Payment |
| `createOrder` | action | createOrder |
| `createOrderItem` | action | createOrderItem |
| `createPayment` | action | createPayment |
| `deleteOrder` | action | deleteOrder |
| `deleteOrderItem` | action | deleteOrderItem |
| `deletePayment` | action | deletePayment |
| `updateOrder` | action | updateOrder |
| `updateOrderItem` | action | updateOrderItem |
| `updatePayment` | action | updatePayment |
| `check_approval` | approval-check | — |
```

There is no `execute_sql` on that list, and nothing on it takes a query. Each action's input
is a zod schema derived from your own columns, so `deletePayment` accepts an `id` and refuses
everything else; each read is a `findUnique` by id or a paged `findMany`. The `filter` on that
`findMany` is derived from your columns the same way — each declared field as a value or a
bounded set of operators (`gte`, `contains`, `in`), published in `tools/list` and **enforced
before it reaches the database**, so it is a fixed set of predicates rather than a query
language wearing a schema. The set is fixed at generation time, it is the same on every run
over the same schema, and you can read all of it in `ontology/` before an agent ever connects.

**Be exact about what that costs.** A fixed surface is a narrow one. There is no aggregation,
no join and no free-form query here, so a question this surface cannot express has to be
answered somewhere else — stated in full under
[What orangerail does not govern](#what-orangerail-does-not-govern), along with the two
larger limits: orangerail sees only its own tools, and it has no DDL.

## See it stop an agent

Approval is a property of an action, not the reason the project exists — but it is real, and
it is the part that is easiest to show working. A real MCP client (the same kind an agent
host uses) tries a destructive delete. The server shows up and blocks it — and the agent
cannot force it through. Only after a human decides does it run, on a verifiable audit
chain.

![orangerail blocks a destructive agent action, then runs it only after a human approves](./examples/governed-writes/demo.gif)

This is one real run of
[`examples/governed-writes/walkthrough.mjs`](./examples/governed-writes) — run it yourself:

```console
THE AGENT SIDE — a real MCP client tries to delete, and gets blocked
[host log]    orangerail mcp: serving · governance active · 6 action(s) approval-gated · matches the recorded baseline · audit chain OK (4 record(s))
[agent]       connected — 11 tools available, incl. deleteArticle
[agent]       task: "clean up the old 'ship-it' post" → deleteArticle({ id: 13 })
[orangerail]  🛑 BLOCKED — "approval_pending", NOT executed. approvalId=fdbb4b96…
[db check]    article 13: STILL THERE ✋
[agent]       blocked. trying to push it through myself → check_approval (no human yet)
[orangerail]  ⛔ "pending" — the agent cannot self-approve.
[db check]    article 13: STILL THERE ✋

THE OPERATOR SIDE — the human sees exactly that, in another terminal
   orangerail status
     objects:  2
     actions:  6 approval-gated, 0 auto
     baseline: 6 action(s) match orangerail.governance.json
     preset:   approval-for-writes
     pending:  1 approval(s) awaiting a decision
     server:   running (pid 42798, started 0s ago)
     audit:    chain OK — 5 record(s) verified
   [human]       $ orangerail approvals approve fdbb4b96…

BACK TO THE AGENT — only now does it run
[agent]       check_approval again → "executed"
[db check]    article 13: gone
[human]       $ orangerail audit verify → audit chain OK — 8 record(s) verified.
```

A read-only switch can't do this: the destructive tool stays **available** (not
hidden), the agent **cannot force it through**, and the row changes **only after a
human decided**. Run it yourself → [`examples/governed-writes`](./examples/governed-writes).

## Quickstart

The shortest true path from zero to watching an agent get blocked. Every output below is
verbatim from one run against the published `0.1.0` packages, in a scratch project holding
nothing but a two-model Prisma schema (`Customer`, `Order`) — no checkout of this repo,
nothing built from source.

**Requirements: Node 20 or newer** for the `orangerail` CLI and `orangerail-mcp` (Node 18
for `orangerail-core`, `orangerail-docs-gen` and `orangerail-studio` on their own). Every
package declares this in `engines.node`, so npm warns before you install onto a runtime
that cannot load it.

**1. Scan your project.** Run this in a repo that has a `prisma/schema.prisma` or an
OpenAPI spec. The scanner is deterministic: it reads your files, makes no LLM calls, and
needs no API key. `--yes` takes the defaults instead of prompting, and `--no-studio` keeps
the run in the terminal.

Have a live database and no schema file? `prisma db pull` writes one — the whole path,
for Prisma 6 and Prisma 7, is in
[Adopting orangerail against an existing database](./docs/existing-database.md).

```console
$ npx orangerail init --yes --preset approval-for-writes --no-studio
  ✓  scanned your sources — 2 object(s), 6 action(s)
  ✓  generated a governed MCP server under ontology/
  ✓  6 write action(s) gated behind human approval
  ⚠  no governance baseline recorded — the generated config did not load

  These files are yours — re-scans never modify them; `orangerail sync` reports drift.
  orangerail.governance.json is what makes a later "someone deleted an approval gate" visible.
  Recording it needs the config to load, so run `orangerail sync --accept-governance`
  once the step below is done, and commit the file.

Next step: install the runtime deps so the generated code can load:
  npm install orangerail-core zod
Then run `orangerail studio` or `orangerail mcp`.
```

That warning is the first run's shape, not a failure: `orangerail-core` is not installed
yet, so the config init just wrote cannot be imported, and the governance baseline is read
off the **live registry** — never off the generated text. In a project that already has
the runtime installed, init records the file itself and the line reads `✓ recorded that
posture in orangerail.governance.json`. Either way step 7 below is where it is settled.

**2. Install the runtime the generated code loads.**

```bash
npm install orangerail-core zod
```

**3. Read the posture.** `orangerail status` is the one screen that answers "is this
actually protecting me" — how many actions are gated, what is waiting on a human, and
whether the audit chain still verifies.

```console
$ npx orangerail status
orangerail status
  objects:  2
  actions:  6 approval-gated, 0 auto
  baseline: NONE — orangerail.governance.json does not exist, so nothing on disk says which of the
            gates above were ever intended. Run `orangerail sync --accept-governance`.
  preset:   approval-for-writes
  pending:  0 approval(s) awaiting a decision
  server:   not detected — no orangerail mcp is running against this store
  audit:    chain OK — 0 record(s) verified
```

`6 approval-gated, 0 auto` is a true sentence about an ontology someone has just un-gated,
too. The `baseline:` line is the only one that can tell the difference, which is why it
sits directly under the counts and why it is loud while it is missing.

**4. Point your agent host at it.** Drop this in your project root as `.mcp.json`. The
lifecycle, the `claude mcp add` one-liner and the `--config` argument for hosts that start
elsewhere are all in [Wire it into your agent host](#wire-it-into-your-agent-host).

```json
{
  "mcpServers": {
    "orangerail": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orangerail", "mcp"],
      "env": { "DATABASE_URL": "file:./dev.db" }
    }
  }
}
```

**5. Ask the agent to destroy something.** Here a real host, wired exactly as above,
called the destructive tool. It came back holding an approval id instead of a deleted row:

```console
[agent]  deleteCustomer({ id: 2 })
         → {"status":"approval_pending","approvalId":"dff95d9d-8237-407a-b80b-c47252d56a1f"}
```

**6. You decide, in your own terminal.** The `server:` line reads a live heartbeat, and
the host's server had already exited by the time this ran — that is the stdio lifecycle,
not a fault.

```console
$ npx orangerail approvals list
dff95d9d-8237-407a-b80b-c47252d56a1f  "deleteCustomer"  by "local-dev" [dev]  5s ago  input={"id":2}

1 pending approval(s).

$ npx orangerail status
orangerail status
  objects:  2
  actions:  6 approval-gated, 0 auto
  baseline: NONE — orangerail.governance.json does not exist, so nothing on disk says which of the
            gates above were ever intended. Run `orangerail sync --accept-governance`.
  preset:   approval-for-writes
  pending:  1 approval(s) awaiting a decision
  server:   not detected — no orangerail mcp is running against this store
  audit:    chain OK — 1 record(s) verified

$ npx orangerail approvals approve dff95d9d-8237-407a-b80b-c47252d56a1f
approve ok (approved)
```

The agent's next `check_approval` is the first moment the row can change. Nothing ran
before you said so, and every step is on the hash chain.

**7. Review the governance baseline — and commit it.** `ontology/` is yours to edit,
which means the one line that disarms this whole flow (`policy: { approval: 'required' }`)
is one careless deletion away, and a re-scan cannot notice: the scanner has no opinion on
policy. So the posture is compared against a recorded file.

That file is `orangerail.governance.json`, at your repo root: one row per action holding
its approval gate, approver roles, `where` guard and target. **Commit it.** Its whole
value is that a pull request removing an approval gate shows `"approval": "required"`
turning into `null` in its own diff, in front of a human reviewer, before CI runs at all.

```bash
npx orangerail sync --accept-governance
```

The file records **who wrote it**. `init` writes one itself whenever the generated config
loads, stamped `"recordedBy": "init"` — the posture init *generated*, before anyone
reviewed it, so that drift is detectable from the first minute without anybody's approval
being faked. `--accept-governance` re-records it as `"recordedBy": "sync"`, which is the
human assertion, and stops the "not yet reviewed" notice. It is also how you acknowledge a
posture change you meant to make later on.

From then on:

- **`orangerail sync` exits 1** when the posture *weakens* — a gate removed, a `where`
  guard removed or rewritten, approver roles widened, an action retargeted, or a new
  action that is not gated — and passes quietly when it tightens.
- **`orangerail mcp` refuses to serve the weakened action.** It is not in `tools/list`
  and the engine will not resolve it by name, so it cannot be staged or executed. Every
  other action and every read tool is served normally, and the startup line names what it
  withheld. Reporting alone was not enough: an un-gated action is *legitimately* un-gated,
  so it runs, and the audit chain records nothing anomalous — `audit verify` stays green.
- **`orangerail status` shows the baseline** next to the action counts and exits 1 when
  the posture is weaker than it, because `18 approval-gated, 1 auto` is a true sentence
  about an ontology somebody just un-gated.

Three things to expect, all deliberate:

- **A project with at least one action and no baseline at all exits 1** from `sync` until
  you have run `--accept-governance` once. Projects created before this existed go red
  exactly once, on purpose: the alternative is that deleting the file buys silence. A
  project with zero actions has no posture to vouch for and is never nagged. The *server*
  still starts in that state — locking you out of a project that predates the file would
  be punishment, not protection.
- **A missing or unreadable baseline never stops the server.** Deleting the file is always
  an available downgrade, so failing closed on a corrupt one would buy no safety and cost
  you your server over a JSON typo. Both states are reported loudly and neither reads as
  verified.
- **A functional `where` predicate is opaque to the check.** It records as the constant
  `functional`, exactly as it does to the action signature hash, so rewriting the body of
  one is invisible here. Sync says so in its own output rather than implying coverage it
  does not have.

What this defends against, stated plainly: *unnoticed* change — a bad merge, a careless
refactor, or the governed agent itself editing the repo it has file tools over. It is not
a defense against someone with write access to your repo who means it; they can edit
`orangerail.config.mjs` and own everything regardless.

(`orangerail.governance.json` and `--accept-governance` are new since `0.1.0` — the
[CHANGELOG](./CHANGELOG.md) maps every user-visible change to its release.)

## See your whole domain as a map

`orangerail studio` reads your declared ontology and opens a live, read-only map of
your domain — every object, how they relate, and every write action an agent can
reach. Hover a table to light up its relations and actions; click one to see its
fields, links, and the **actions you can take on it** — each with the policy that
governs it (`deleteProduct` → approval required).

![the orangerail studio map — hovering tables to reveal relations, then focusing the actions an agent can take on a table](./assets/studio-map.gif)

> Crisper version: [`assets/studio-map.mp4`](./assets/studio-map.mp4). The map above is
> one real run of `orangerail studio` on a sample commerce domain — run it on your own
> project (or the [`governed-writes`](./examples/governed-writes) example) to explore
> yours.

The relations drawn there come from `ontology/_links.mjs`, which `orangerail init` derives
from your Prisma relations — one `defineLink` per relation pair, carrying a `cardinality` of
`one` or `many`. `orangerail studio` and `orangerail docs` both read that graph, and so does
`orangerail mcp`: each read tool states its object's relations in one clause of its
description, so `Customer_list` reads `List Customer records. Relations: has many Order.`

**Be exact about what that is worth, because it is easy to over-read.** The agent is *told*
that a Customer has many Orders. It still cannot follow the edge: there is no traversal tool,
no join, no aggregate, and `Customer_list` will refuse a filter that reaches into `Order` —
that refusal is the point, not a limitation of it. What the sentence buys is that an agent
holding `Customer_list` and `Order_list` knows the two are connected and which way the
cardinality runs, instead of inferring it from column names. Knowing the shape of the domain
and being able to query across it are different things, and only the first one is here.

## What orangerail will be

The domain rules you've been hand-writing into scattered markdown — product
statuses, order invariants, "never issue a coupon for a sold-out item" — declared
once in TypeScript (zod-native), and compiled into the three things an AI agent
working against your system actually needs:

- **A prompt rail** — generated domain docs for `AGENTS.md`, so agents are *guided*
  to behave well.
- **A runtime rail** — a typed MCP server with staged write-actions, human-in-the-loop
  approval, and a hash-chained audit log, so agents are physically *stopped* when
  they don't. What that log does and does not prove is stated exactly in
  [What the audit log proves](#what-the-audit-log-proves).
- **A map you can trust** — a live, read-only studio view of your objects, links,
  and actions, so you can *see* exactly what an agent can reach and confirm it
  matches your intent.

One declaration is the single source of truth for all three — they cannot drift
apart, because they are generated, not maintained by hand.

```ts
import { defineAction, defineObject } from 'orangerail-core';
import { z } from 'zod';

// Your existing backend. orangerail never replaces it — it only gates the call.
declare const findProduct: (id: string) => Promise<{ id: string; status: string } | null>;
declare const grantCoupon: (args: { productId: string; amount: number }) => Promise<void>;

// A `where` guard has to read the row it guards, so the target needs `resolve`.
export const Product = defineObject({
  name: 'Product',
  schema: z.object({ id: z.string(), status: z.string() }),
  resolve: { get: async ({ id }) => findProduct(id) },
});

export const issueCoupon = defineAction({
  name: 'issueCoupon',
  target: Product,
  input: z.object({ productId: z.string(), amount: z.number() }),
  policy: {
    approval: 'required',
    where: { field: 'status', op: 'neq', value: 'soldout' },
  },
  // `execute` runs only after the approval clears, and receives the validated
  // input plus the resolved caller. There is no `audit` switch: every staged,
  // approved, rejected and executed action is written to the hash chain.
  execute: async ({ input, identity }) => {
    await grantCoupon({ productId: input.productId, amount: input.amount });
    return { issuedBy: identity.subject };
  },
});
```

That block is not an illustration — it is
[`packages/cli/test/readme-example.ts`](./packages/cli/test/readme-example.ts) printed
verbatim, compiled by the repo typecheck and compared against this file on every run, so
it cannot rot into something that never compiled.

## v0 scope (in development)

- `orangerail init` — deterministic scanner (Prisma / OpenAPI) that extracts your
  ontology from code instead of asking you to type it. No LLM calls, no API keys —
  ever.
- `orangerail sync` — re-scan your sources and report drift, including a change in
  the governance posture itself. It compares the approval gates, approver roles,
  `where` guards and targets against `orangerail.governance.json` (a committed
  baseline `init` records and `orangerail sync --accept-governance` re-records), so a
  removed approval gate fails the run instead of passing as "in sync". Exit **0** when
  there is nothing to act on, **1** for any unresolved drift — a proposal, a changed
  field, an ontology file the loader never imports, a weakened posture — and **2** when
  it could not answer at all (the config would not load, the baseline could not be read).
- `orangerail mcp` — typed MCP server over your declared objects and actions. Each read
  tool names its object's links and publishes a closed `filter` over that object's own
  fields, which the server enforces before the value reaches a resolver — the tools are
  relation-*aware*, never relation-traversing. It withholds any action whose posture is
  weaker than the recorded baseline: not listed, not resolvable, not executable, while
  everything else is served.
- `orangerail docs` — the agent-facing domain document (the prompt rail): the tool table,
  the object fields, the link table with its cardinality column, and every action with the
  policy that governs it. Written to `.orangerail/generated/AGENTS.md`.
- `orangerail approvals` — CLI approval queue for staged actions.
- `orangerail audit verify` — hash-chain verification of the audit log, cross-checked
  against the approvals store. Read [What the audit log proves](#what-the-audit-log-proves)
  before you rely on it as a security control.
- `orangerail studio` — the live, read-only map of your domain graph.

Everything here runs from your repository alone — no external exports, no accounts,
no keys. Point it at your own code and it works.

## How this compares

Deterministic codegen from a spec into MCP tools is not new, and neither is a database MCP
server. What is specific here is the pair: typed per-entity tools generated from your schema
instead of a generic query tool — including the read `filter`, which is a closed set of
predicates over declared fields that the server enforces, rather than a `where` clause the
agent composes — and a per-action approval gate with a recorded baseline that `sync` and `mcp`
both enforce. Each claim below was checked against the shipped package or the vendor's own
documentation on 2026-07-29.

- **[`openapi-mcp-generator`](https://github.com/harsha-iiiv/openapi-mcp-generator)** (627
  stars; 16,389 npm downloads in the week ending 2026-07-28) is real prior art on the
  OpenAPI half, and good at it. Its `extractToolsFromApi` walks paths × methods and emits
  exactly one tool per operation — deterministic, zod-validated, no LLM anywhere in it, with
  content-hash name de-collision so a reordered spec produces the same output. What it does
  not have is any approval policy: an operation that deletes becomes a tool that deletes, and
  it runs when the agent calls it. That is the substance of the difference, and it is about
  the write path; on relations orangerail is now ahead by one clause of prose per read tool,
  which is worth about what that sounds like — an OpenAPI spec has no relation graph to
  derive one from in the first place. If one tool per REST operation is all you want, it is
  more mature at that than orangerail is.
- **Prisma's own MCP servers** are CLI and platform operations, not per-model tools. The
  local server in `prisma@7.9.1` (`npx prisma mcp`) registers three tools — `migrate-status`,
  `migrate-dev` and `Prisma-Studio` — each shelling out to the Prisma CLI. The
  [hosted server](https://www.prisma.io/docs/postgres/integrations/mcp-server) covers
  databases, backups, recovery and connection strings, plus `ExecuteSqlQueryTool` and
  `IntrospectSchemaTool`. Neither generates anything typed per model.
- **[Supabase's MCP server](https://github.com/supabase/mcp)** exposes `list_tables` and
  `execute_sql`. Foreign keys are not missing — each table in a `list_tables` response can
  carry a `foreign_key_constraints` array of constraint rows (name, source and target table,
  source and target columns), but only when the call passes `verbose: true`; without it the
  handler returns the compact table and drops them. That is an introspection payload for the
  agent to interpret, not a declared relation carrying a cardinality; orangerail puts the
  cardinality on the surface, in the read tool's own description
  (`Relations: has many Order.`). Be clear about the size of that difference: it is one
  sentence per tool. It saves an agent a `verbose: true` round trip and the work of turning
  constraint rows into a direction, and it buys nothing else — orangerail cannot follow the
  relation either, and unlike `execute_sql` it cannot express the join that would. Compared
  against Supabase the honest summary is a narrower surface with a clearer label on it, not a
  more capable one.

## Wire it into your agent host

`orangerail mcp` is a **stdio** MCP server. There is no daemon and nothing to toggle:
the agent host spawns it as a child process, speaks JSON-RPC over its stdin/stdout, and
it dies when the host does. You never start it by hand — you tell the host how to start
it, and the host does the rest. (`orangerail status`, `approvals`, and `audit verify` are
ordinary commands you run in your own terminal, against the same store, while the host's
server is up.)

Nothing to install and nothing to build: the package is on npm, so the host can fetch and
run it on demand. For Claude Code, a `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "orangerail": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orangerail", "mcp"],
      "env": { "DATABASE_URL": "file:./dev.db" }
    }
  }
}
```

Or the equivalent one-liner, which writes exactly that file:

```bash
claude mcp add -s project orangerail -e DATABASE_URL="file:./dev.db" \
  -- npx -y orangerail mcp
```

`env` carries whatever your own `orangerail.config.mjs` needs to reach your backend — the
`DATABASE_URL` above is what the Prisma example uses. The server resolves the config from
the host's working directory; when that is not your project root, name it explicitly by
appending `"--config", "/abs/path/to/orangerail.config.mjs"` to `args`. Verify with
`claude mcp list`:

```console
$ claude mcp list
orangerail: npx -y orangerail mcp - ✔ Connected
```

A project-scoped `.mcp.json` is only connected to once you have trusted the directory in
the host; until then the same line reads `⏸ Pending approval`, which is the host asking,
not the config being wrong. As the server comes up it writes one line to stderr (stdout is
the JSON-RPC channel), which lands in your host's log:

```console
orangerail mcp: serving · governance active · 6 action(s) approval-gated · matches the recorded baseline · audit chain OK (0 record(s))
```

**From source instead.** If you are working on orangerail itself, or want to run an
unreleased change, point the host at your build rather than at npm. `dist/` is not
committed, so build first:

```bash
git clone https://github.com/KimHyeongRae0/orangerail.git
cd orangerail
pnpm install && pnpm -r run build     # produces packages/cli/dist/main.js
```

Then swap the server object's `command` and `args` for that file — everything else stays
the same:

```json
{
  "command": "node",
  "args": ["/abs/path/to/orangerail/packages/cli/dist/main.js", "mcp"]
}
```

### Also ask the host to prompt (optional, off by default)

An action you declared **without** `policy: { approval: 'required' }` has no orangerail
gate: calling its tool runs it. If your host has a permission prompt of its own, orangerail
can ask it to fire on every call to exactly those tools, by setting one field in
`orangerail.config.mjs`:

```js
export default {
  registry,
  store,
  // 'off' (default) | 'ungoverned-actions' | 'all-actions'
  hostApprovalPrompt: 'ungoverned-actions',
};
```

That adds `_meta: { "anthropic/requiresUserInteraction": true }` to those tools' entries in
`tools/list`. **Claude Code v2.1.199 and later is the only host known to honor it.** The
key is vendor-prefixed, which the MCP specification reserves for exactly this, so any other
host reads it as metadata it does not recognize and ignores it — there is no behavior change
anywhere else and nothing to disable.

`'all-actions'` extends it to your governed actions too. That is a second prompt in front of
a call that only *stages* an approval, so the write still cannot happen either way; what it
buys is that an agent cannot silently fill your approval queue. Most people should not want
it. Read tools and `check_approval` are never annotated under any setting: `check_approval`
is polled in a loop until a human decides, and a prompt on every poll is unusable.

Be deliberate about turning this on, because the flagged tool's prompt is not one the person
at the keyboard can dismiss. Per Claude Code's documentation it appears in every permission
mode including `bypassPermissions`, offers no "don't ask again", and is not skipped by an
allow rule; in `dontAsk` mode, which never prompts, the call is **denied** instead. A
headless pipeline that was working can stop working. That is why the default is `'off'`, and
why for a one-off you may prefer an ordinary `ask` rule in your host's own settings — that
one you can take back.

And to be exact about what this is: the annotation is enforced by the **client**. It is not
what makes orangerail's gate hold. A governed action stages and waits for a human no matter
which host is driving, whether that host prompts, and whether it honors this key at all. The
host prompt is a second checkpoint on top of the rail — never the rail.

## What orangerail does not govern

orangerail is a rail, and a rail only governs the traffic that runs on it. It sees exactly
one thing: calls made through its own MCP tools. Anything else the agent can reach is
invisible to it — a shell tool, a `psql` or `prisma studio` session, a second
database MCP server, your app's REST API, a background job someone else wrote. Nothing in
orangerail blocks those, stages them, or records them; they simply never happen as far as
the audit chain is concerned.

So the guarantee is a conditional one, and it is worth stating exactly: **when orangerail's
tools are the agent's only route to your domain, every write is staged, approved and
audited.** Closing off the other routes is your job, not the rail's.

This is not a theoretical caveat. In a validation run against live PostgreSQL, with
orangerail installed and every write action gated, a second Postgres MCP server was added on
the same database and the agent deleted five rows through it with zero approvals and nothing
on the audit chain. The gate held on its own tools and was simply not on the path. Treat "the
agent has exactly one route to this database" as a precondition of installing orangerail, not
as advice.

**There is no aggregation, no join, and list results are capped.** The generated read tools
are exactly two shapes: a `findUnique` by id, and a `findMany` with your filter, ordered by
id, returning 50 rows by default and 200 at most, with a cursor to page. There is no
`groupBy`, no `_sum`, no `_count` and no join anywhere in the generated code, so "what did we
bill this customer last quarter" is not a question this surface can answer — the agent must
page the rows and do the arithmetic itself, or the question goes somewhere else entirely.

One consequence is worth naming, because it is easy to mistake for a feature. An aggregate
spanning two one-to-many relations off the same parent — the classic *fan trap*, where the
number comes back silently multiplied and no error is raised — cannot be asked through
orangerail. That is the absence of a capability, not a guard against a mistake. The read
tools do state each object's cardinalities in their descriptions, and that changes nothing
here: there is no aggregate to get wrong, so there is nothing for the cardinality to protect.
If the agent has any other route to SQL, it can still write that query, and orangerail will
neither see it nor say anything about it.

**There is no DDL.** From a Prisma schema the scanner emits row-level writes only — create,
update and delete per model, one row at a time, and create alone for a model with no single
`@id` — and nothing at all for schema change. `CREATE TABLE`, `ALTER TABLE`,
`DROP TABLE` and every migration have no generated action, so they go around orangerail
entirely and are neither gated nor audited. Keep migrations where they already are: in your
migration tool, reviewed in a pull request, run by CI or by a person — not by the agent. If
the agent needs to propose one, have it write the migration file and let the normal review
path decide, because that path is a human checkpoint orangerail is not offering here.

**A bulk intent costs one approval per row.** "Delete the 40 stale drafts" is 40 calls to
`deleteArticle`, 40 staged approvals, and 40 decisions — the generated actions take a single
id, `orangerail approvals approve` takes a single id, and there is no batch action and no
approve-all. That is honest about the ergonomics today rather than a design position. Where a
bulk operation is a real part of your workflow, the way out is to hand-write one
`defineAction` whose `execute` performs the whole batch, so a single approval covers a single
reviewed intent — the generated per-row actions are a starting point, and `ontology/` is
yours to edit.

## What the audit log proves

`orangerail audit verify` checks a lot. Every record's `hash` must recompute over its own
content and every `prevHash` must link to the record before it, so an edited or reordered
record breaks the walk. The chain is measured against a checkpoint persisted outside it
(`audit.head.json`), so a tail lopped off `audit.jsonl` alone is caught. Every started
execution must have a terminal record. And the audit chain and the approvals store are
cross-checked against each other wherever they overlap — staging, decision, decider,
requester, action, consumption, and the approved payload itself — so neither log is
trusted on its own and forging one of them is not enough.

That is a real bar. It is not the bar the phrase "tamper-evident" implies, so this project
does not use it. Stated exactly:

> An attacker with write access to the store directory can still delete audit records,
> re-chain the survivors with the public `hashAuditRecord`, re-anchor the unsigned
> `audit.head.json` that sits beside them, and edit `approvals.jsonl` to match — and
> `orangerail audit verify` will report the result as OK; what this release adds is that
> tampering with only *one* of the two logs, or with either one carelessly, is now
> detected.

The chain hash is unkeyed, `hashAuditRecord` is exported from `orangerail-core`, and the
anchor is an unsigned JSON file in the same directory as the records it anchors. So what
orangerail gives you today is **a human checkpoint and an audit trail** — a gated write
cannot execute without a person deciding, and every staged, approved, rejected and
executed action is on the chain — and not a tamper-evident boundary against someone who
owns the disk.

### Keep the store out of the agent's reach

All of that turns on who can write the store directory, and the default is the wrong
answer for a governed agent. `orangerail init` scaffolds the store **inside the project it
just scanned** — the generated `orangerail.config.mjs` builds it as:

```js
const store = createFileStore({ dir: join(here, '.orangerail', 'store') });
```

That is convenient for a local single-user run, and it is the worst available choice the
moment the governed agent also has file tools over that repo: the agent has write access
to the very log that records what it did, which is precisely the attacker in the paragraph
above.

There is no CLI flag for this, and no other mechanism: the store location is the `dir`
argument of `createFileStore`, and `orangerail.config.mjs` is a user-owned file that `init`
refuses to regenerate. Relocating the store is therefore a one-line edit you make once:

```js
const store = createFileStore({ dir: '/var/lib/orangerail/store' });
```

A correct deployment points that path at a directory the agent's tools cannot reach —
outside the workspace, owned by the operator account, with the agent's process holding no
write permission on it. The orangerail MCP server writes it; the agent never does. Its only
route is the MCP tools, which stage, poll and read your domain, and never expose the store
directory. If the agent and the operator are the same OS user on the same machine, you have
a human checkpoint and an audit trail and no boundary — which is exactly what the section
above says you have.

## Docs

- [Adopting orangerail against an existing database](./docs/existing-database.md) —
  `prisma db pull` onto a live database, what Prisma 7 changes (a driver adapter is
  required, and the connection URL moves to `prisma.config.ts`), and the errors you hit
  if you skip a step.

## Examples

Runnable, end-to-end examples live in [`examples/`](./examples). Each runs orangerail
on a single concept and proves the behaviour with real output:

- [`governed-writes`](./examples/governed-writes) — a destructive write stays
  available to an agent but is staged for human approval instead of executing, on a
  verifiable audit chain. Resolves the read-only-vs-write dilemma.

## Development

This repo is built under a deterministic 9-stage gate harness. Every change runs
through [`./scripts/verify.sh`](./scripts/verify.sh) — language, structure, gate
self-test, no-LLM, templates, then typecheck / lint / test / build — and CI runs that
script and nothing else, so a green local run is a green build. Each gate is a readable
script in [`scripts/`](./scripts) with its rules in its own header comment; the layout it
enforces is the tree you see. A hard invariant: no LLM-inference SDK is ever bundled
([`./scripts/check-no-llm.sh`](./scripts/check-no-llm.sh)).

## License

[MIT](./LICENSE)
