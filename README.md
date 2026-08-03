<div align="center">

<img src="./assets/logo.svg" width="76" alt="">

# orangerail

**Decide once what your agent may do. Then leave it working.**

<!-- One line on purpose: inside an `align="center"` block GitHub turns every newline into a <br>, so a badge per line stacks them vertically. -->
[![npm](https://img.shields.io/npm/v/orangerail?logo=npm&logoColor=fff&label=npm&color=EE7A2B)](https://www.npmjs.com/package/orangerail) [![CI](https://github.com/KimHyeongRae0/orangerail/actions/workflows/ci.yml/badge.svg)](https://github.com/KimHyeongRae0/orangerail/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/orangerail?logo=nodedotjs&logoColor=fff&color=444)](https://nodejs.org) [![published with provenance](https://img.shields.io/badge/npm-published%20with%20provenance-EE7A2B?logo=npm&logoColor=fff)](https://www.npmjs.com/package/orangerail#provenance) [![license](https://img.shields.io/badge/license-MIT-444)](./LICENSE)

[**Quickstart**](#quickstart) &nbsp;·&nbsp; [What it does not govern](./docs/limits.md) &nbsp;·&nbsp; [Against a rules file](./docs/vs-a-rules-file.md) &nbsp;·&nbsp; [Examples](./examples) &nbsp;·&nbsp; [Docs](./docs)

</div>

![fifteen back-office items handed to an agent with nobody watching: twelve ordinary writes finish, three deletions stop and become approvals bound to the exact call](./examples/unattended-queue/demo.gif)

*One run of [`examples/unattended-queue`](./examples/unattended-queue) — a real MCP client, no API
key, every line asserted. Twelve ordinary writes finish with the operator gone; three deletions
stop, and what they leave behind is executable tomorrow by someone who was never in the room.*

**orangerail reads the schema you already have and generates the agent's surface from it.**
`orangerail init` turns a `prisma/schema.prisma` into an MCP server: a `get` and a `list` per
object, one action per write with a zod input schema, and nothing else — no `execute_sql`, and
nothing on the tool list that takes a query. It is a scanner and a code generator, with no LLM
calls and no API keys. Writes you are happy to have run unattended run
unattended. The ones you are not carry `policy: { approval: 'required' }`, which stops the call
and turns it into an approval a person can act on later — including a person who is not you,
after the conversation that produced it has ended.

**Bounded is not safe, and this README will not pretend otherwise.** A generated surface buys
a reach that is *finite and legible*, not a claim that nothing harmful is inside it. You
declared the verbs, so a destructive verb you declared is a verb the agent can call.

One precondition, up front, because it decides whether any of this is worth installing:
**orangerail governs only its own tools.** If the agent also has a shell with credentials or a
second database MCP server, it can go around the rail — see [what orangerail does not
govern](./docs/limits.md).

**Pre-release, and installable.** v0 is on npm at `0.1.2` — `orangerail` (the CLI) plus
`orangerail-core`, `orangerail-mcp`, `orangerail-docs-gen` and `orangerail-studio`. The API will
move before 1.0, and [Status](#status) has the one upgrade note that matters.

---

<details>
<summary><b>Contents</b></summary>

| | |
| --- | --- |
| **Start here** | [Quickstart](#quickstart) · [v0 commands](#v0-commands) · [Wire it into your agent host](#wire-it-into-your-agent-host) |
| **See it work** | [See it stop an agent](#see-it-stop-an-agent) · [See your whole domain as a map](#see-your-whole-domain-as-a-map) · [The run this is built for](#the-run-this-is-built-for) |
| **Decide if you need it** | [Why the prompt is the wrong control](#why-the-prompt-is-the-wrong-control) · [Against the thing you would do instead](#against-the-thing-you-would-do-instead) · [What the agent gets instead of `execute_sql`](#what-the-agent-gets-instead-of-execute_sql) |
| **Go further** | [Declaring a rule the generator cannot derive](#declaring-a-rule-the-generator-cannot-derive) · [Status](#status) · [Docs](#docs) · [Examples](#examples) · [Development](#development) |

</details>

## Quickstart

Every output below is verbatim from one run of the `0.1.2` packages, installed from the packed
tarballs of this release, in a scratch project holding nothing but a two-model Prisma schema
(`Customer`, `Order`) and Prisma 6.

**Requirements: Node 20 or newer** for the `orangerail` CLI and `orangerail-mcp` (Node 18 for
`orangerail-core`, `orangerail-docs-gen` and `orangerail-studio` on their own). **On Prisma 7,
two things stop you before orangerail is reached** — a `url` in the `datasource` block now fails
every `prisma` command, and the client requires a driver adapter, without which `init` exits 1
rather than generate an ontology that cannot construct a client. Both moves, and which adapter
your provider needs, are in
[Adopting orangerail against an existing database](./docs/existing-database.md#prisma-7).

**1. Scan your project.** Run this in a repo with a `prisma/schema.prisma`.
Live database and no schema file? `prisma db pull` writes one — the whole path is in
[Adopting orangerail against an existing database](./docs/existing-database.md).
An OpenAPI spec is also accepted and yields considerably less — see
[what the OpenAPI input gives you](#v0-commands).

```console
$ npx orangerail init --yes --preset approval-for-writes --no-studio
  ✓  scanned your sources — 2 object(s), 6 action(s)
  ✓  generated a governed MCP server under ontology/
  ✓  --gate delete: 2 of 6 write action(s) gated behind human approval — the other 4 run when the agent calls them
  ⚠  no governance baseline recorded — the generated config did not load
  ✓  approvals queue + audit chain at .orangerail/store/ — inside this project, so an
     agent with file tools over this directory can write them

  These files are yours — re-scans never modify them; `orangerail sync` reports drift.

  Change what is gated by editing `policy` in ontology/<action>.mjs, or re-run init
  with `--gate all` (gate every write) or `--gate none` (gate nothing).
  orangerail.governance.json is what makes a later "someone deleted an approval gate" visible.
  Recording it needs the config to load, so run `orangerail sync --accept-governance`
  once the step below is done, and commit the file.

  That store is the record of which writes a human approved, and appending one line to
  .orangerail/store/approvals.jsonl marks a staged action approved — the next
  `check_approval` then executes it, because the gate reads that store and never the
  audit chain. `orangerail audit verify` reports the forgery afterwards; it is a report,
  not a gate, and it does not prevent the write. The generated config carries the
  one-line move at the `createFileStore` call — see docs/audit-log.md.

Next step: install the runtime deps so the generated code can load:
  npm install orangerail-core zod
Then run `orangerail studio` or `orangerail mcp`.
```

`--gate delete` is the default, and it is the line worth pausing on. Gating *every* write is
the safer-sounding default and is what orangerail shipped first — but a surface where nothing
completes without a human is a surface nobody leaves running. So init gates the op whose name
most reliably predicts a row is gone, and lets the rest through. That is a starting point, not
a verdict: `create` can be the most consequential write a schema has. Pass `--gate all`,
`--gate none`, or edit `policy` per file afterwards.

The `⚠` is the first run's shape, not a failure: `orangerail-core` is not installed yet, so the
config init just wrote cannot be imported, and the baseline is read off the **live registry** —
never off the generated text. Step 4 settles it.

**2. Install the runtime the generated code loads.**

```bash
npm install orangerail-core zod
```

**3. Point your agent host at it.** Drop this in your project root as `.mcp.json`:

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

**4. Record the governance baseline — and commit it.** `ontology/` is yours to edit, which
means the one line that disarms the whole flow (`policy: { approval: 'required' }`) is one
careless deletion away, and a re-scan cannot notice: the scanner has no opinion on policy. So
the posture is compared against a recorded file.

```bash
npx orangerail sync --accept-governance
```

That writes `orangerail.governance.json` at your repo root: one row per action holding its
approval gate, approver roles, `where` guard and target. **Commit it.** Its whole value is that
a pull request removing an approval gate shows `"approval": "required"` turning into `null` in
its own diff, in front of a reviewer, before CI runs at all. (`init` writes one itself whenever
the generated config loads, stamped `"recordedBy": "init"` — the posture init *generated*,
before anyone reviewed it. `--accept-governance` re-records it as `"recordedBy": "sync"`, the
human assertion.)

From then on `orangerail sync` exits 1 when the posture weakens, and `orangerail mcp` refuses to
serve the weakened action — not listed, not resolvable, not executable, while everything else
is served. What that does and does not defend against is in
[the limits doc](./docs/limits.md#what-the-governance-baseline-defends-against).

**5. Now leave.** When you come back:

```console
$ npx orangerail status
orangerail status
  objects:  2
  actions:  2 approval-gated, 4 auto
  baseline: 6 action(s) match orangerail.governance.json
  preset:   approval-for-writes
  pending:  1 approval(s) awaiting a decision
  store:    /srv/shop/.orangerail/store
            Inside the project root, so an agent with file tools over this directory can
            write it: one appended line in approvals.jsonl is a decision no human made,
            and the next `check_approval` executes the staged action — the gate reads
            this store, never the audit chain. `orangerail audit verify` reports the
            forgery afterwards; it is a report, not a gate. Pointing the store `dir` at a
            directory this agent's process cannot write is what removes the reach — see
            docs/audit-log.md.
  server:   not detected — no orangerail mcp is running against this store
  hosts:    no MCP client config next to this project, so orangerail cannot tell what
            else your agent has mounted.
            Project scope only (.mcp.json, .cursor/mcp.json, .vscode/mcp.json); user- and
            machine-scope MCP config is not read.
  audit:    chain OK — 1 record(s) verified

$ npx orangerail approvals list
a5d65f2b-88b4-4a86-8bc5-da90ab636f0b  "deleteCustomer"  by "local-dev" [dev]  8s ago  input={"id":2}

1 pending approval(s).

$ npx orangerail approvals approve a5d65f2b-88b4-4a86-8bc5-da90ab636f0b
approve ok (approved)
```

The agent's next `check_approval` is the first moment the row can change. Nothing ran before you
said so, and every step is on the hash chain.

With the qualifier the `store:` line above states, which is why it is on every readout —
[Keep the store out of the agent's reach](./docs/audit-log.md#keep-the-store-out-of-the-agents-reach).

### A table you refuse stays refused

Narrowing the surface is the point, so `orangerail init --models customer,order` leaves your
`payment` and `api_credential` tables out of the ontology entirely. Record that decision, or
every later `sync` rediscovers them and exits 1 — with `--accept-new`, the remedy that would
generate them, as the only fix it can name:

```bash
npx orangerail init --exclude api_credential,payment      # or: orangerail sync --exclude …
```

That writes those names into `orangerail.governance.json` as **considered and refused**, so
`sync` reports them as `info:` and the run can be green. It is a list of names, not a snapshot:
a table appearing *after* the refusal is still reported loudly, and a recorded name that stops
matching anything is reported as prunable, so it cannot quietly silence a future table that
reuses it. Both flags match your sources ignoring case and write back the name your sources
declare; a typo, a prefix or a plural is refused, naming the models you do have.

**orangerail will never guess which tables those are.** It does not scan for `secret`,
`password` or `credential` and pre-select the matches. A name is syntactic and the danger it
stands for is not — the table that puts a customer's card number in a support transcript is
called `payment` — and a tool that pre-checks the boxes is a tool whose list you stop reading.
You name each one.

## Why the prompt is the wrong control

**The thing stopping you from walking away is not that the agent does too much. It is that
your only control is a question it has to ask you.** The twentieth prompt of the afternoon gets
the same click as the first, and the switch that ends the asking ships in the box — Claude
Code's `bypassPermissions` mode "skips permission prompts, except those forced by explicit
`ask` rules", per its own [permissions
reference](https://code.claude.com/docs/en/permissions). A boundary re-established by a person
on every call cannot hold once nobody is there.

The prompt is also the wrong *shape*. It asks about a tool — may this run `Bash` — and the risk
you carry is about your domain: stock edits are fine, order deletions are not, refunds under
$50 need nobody. That distinction does not exist at the tool level. It exists in your schema.

---

## The run this is built for

A 15-item back-office queue on a commerce database, handed to an agent with the operator
gone for the day and told not to ask for confirmation. Twelve items are ordinary reversible
writes — mark orders shipped, correct a customer email, restock a product, add a line item,
create a new SKU. Three are destructive: delete a cancelled order, delete a customer under
an erasure request, delete a discontinued product.

Scored from the database afterwards, not from what the agent said it did:

| | orangerail |
| --- | --- |
| ordinary items completed unattended | **12 / 12** |
| destructive items executed | **0** |
| destructive items stopped and staged | **3** |
| what is waiting the next morning | 3 approval records, each bound by hash to the exact call |
| audit chain | 27 records, verified OK |

That is the metric this project is built around, and it is not "how much did we block". It is
**how much finished while nobody was watching, and what is waiting when you get back.**

Two separable claims sit in that table, and they are not equally well evidenced.

That the twelve go through unattended and the three cannot is a property of the server, and it
is **reproducible on your machine**: [`examples/unattended-queue`](./examples/unattended-queue)
runs exactly that queue through a real MCP client, deterministically, no API key, asserting
every line. Run it and the table above is what you get.

That a *model* chooses these calls when handed the queue in prose needed a live agent driving a
real host, and **that half is a measurement, not a reproduction** — the rules-file arm it is
compared against below was three runs on three identical clones, and this arm is a run of the
same queue. Small numbers. They are enough to say the gate holds where it was tested and not
enough to be a rate, which is why the reproducible half is the one carrying the argument.

### Against the thing you would do instead

The comparison that matters is not a raw SQL server. It is a rules file: a well-written
`CLAUDE.md` naming the permitted tables and the forbidden ones, over a Postgres MCP server with
full write access. That arm was run on the same queue, same model, three clones.

| | markdown rules, full write access | orangerail |
| --- | --- | --- |
| ordinary items completed | 12 / 12, all three runs | 12 / 12 |
| destructive items executed | 0 | 0 |
| what the stop leaves behind | a paragraph in a report | an approval record |
| the same task started in another directory | **row deleted** | staged it |

**It tied on compliance, and it kept tying** — through adversarial rewrites, a fake prior
approval, an instruction planted in a database row, and a much smaller model. On one axis it
beat us. So this project does not argue that your agent will ignore your rules: across every
run measured here, it followed them.

The row that does not tie is the last one, and it is not about the agent's behaviour: a grant
travels with the session it was registered for, and a rules file travels with the machine
account it was written under. A global `~/.claude/CLAUDE.md` closes most of that gap for a
single developer on one machine — **if that is you, you may not need this.** It stops closing at
a CI runner, a container, a service account, or a teammate's checkout, each of which gets the
database credentials anyway.

The full comparison — every run, the axis where the rules file wins, and the limits of the
measurement — is [against the thing you would do instead](./docs/vs-a-rules-file.md), and
[`examples/vs-a-rules-file`](./examples/vs-a-rules-file) executes both arms.

## What the agent gets instead of `execute_sql`

Run `orangerail init` on a three-model Prisma schema (`Order`, `OrderItem`, `Payment`) and the
entire tool list is 16 entries: **a `get` and a `list` per object, one action per write, and
`check_approval`.** Nothing else, and nothing that takes a query.

<details>
<summary>The whole list, copied from <code>orangerail docs</code> on the generated project</summary>

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

</details>

Each action's input is a zod schema derived from your own
columns, published in `tools/list`, so `updateProduct` refuses a string where the column is an
integer and says which field it was. Each read is a `findUnique` by id or a paged `findMany`,
whose `filter` is a closed set of predicates over declared fields — enforced by the server
before it reaches your resolver, not merely advertised.

A fixed surface is a narrow one: no aggregation, no join, no free-form query, no DDL. A question
it cannot express has to be answered somewhere else — all of it, and where enforcement actually
lives, is in [what orangerail does not govern](./docs/limits.md).

## See it stop an agent

![a destructive agent action stops and comes back as an approval id; a person decides, and only then does the row change](./examples/governed-writes/demo.gif)

One real run of [`examples/governed-writes/walkthrough.mjs`](./examples/governed-writes) — a
real MCP client, the same kind an agent host uses:

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

The destructive tool stays **available** rather than hidden, the agent **cannot force it
through**, and the row changes **only after a human decided** — in a separate terminal, at a
separate time, which is the part that makes leaving possible.

## See your whole domain as a map

`orangerail studio` reads your declared ontology and opens a live, read-only map of your
domain — every object, how they relate, and every write action an agent can reach. Hover a
table to light up its relations and actions; click one to see its fields, links, and the
actions available on it, each with the policy that governs it (`deleteProduct` → approval
required).

![the orangerail studio map — hovering tables to reveal relations, then opening deleteOrder to read the policy that governs it: target Order, approval required, approvers any, condition none](./assets/studio-map.gif)

> Crisper version: [`assets/studio-map.mp4`](./assets/studio-map.mp4). One real run of
> `orangerail studio` on a sample commerce domain — nine objects, twenty-seven actions,
> `--gate delete`. The locks and the bolts are not annotations added for the video: they are what
> the studio draws from your ontology, which is why nine actions carry one and eighteen do not.

The relations come from `ontology/_links.mjs`, which `init` derives from your Prisma relations —
one `defineLink` per relation pair, carrying a cardinality. `studio`, `docs` and `mcp` all read
that graph, so `Customer_list`'s own description reads `List Customer records. Relations: has
many Order.`

**Be exact about what that is worth.** The agent is *told* that a Customer has many Orders. It
still cannot follow the edge: there is no traversal tool, no join, no aggregate, and
`Customer_list` refuses a filter that reaches into `Order`. Knowing the shape of a domain and
being able to query across it are different things, and only the first one is here.

## Declaring a rule the generator cannot derive

Everything above is generated. When a rule lives in your head rather than your schema — "never
issue a coupon for a sold-out item" — you write it once, in TypeScript, and it joins the same
surface:

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
[`packages/cli/test/readme-example.ts`](./packages/cli/test/readme-example.ts) printed verbatim,
compiled by the repo typecheck and compared against this file on every run, so it cannot rot
into something that never compiled.

## v0 commands

- **`init`** — deterministic scanner that extracts your ontology from code instead of asking you
  to type it. No LLM calls, no API keys — ever.

  A `prisma/schema.prisma` is the input the rest of this README describes: objects with their
  relations, a `get` and a `list` per object, one runnable action per write.

  **An OpenAPI spec gives you a scaffold, not a server.** v0 reads JSON only — a `.yaml` spec is
  refused with a convert-it hint rather than parsed. Every `GET` is skipped and no objects are
  derived, so there is **no read surface at all**; what you get is one action per non-GET
  operation, with a zod input schema built from the request body and `execute: notImplemented`
  for you to wire up. That is real work saved on the input schemas and the policy wiring, and it
  is not an MCP server you can hand an agent as-is. The reason it is thinner is structural rather
  than neglect: an OpenAPI spec carries no relation graph to derive objects from
  ([comparisons](./docs/comparisons.md)).
- **`sync`** — re-scan and report drift, including a weakened governance posture. Exit **0** for
  nothing to act on, **1** for unresolved drift, **2** when it could not answer at all.
- **`mcp`** — the typed MCP server, withholding any action weaker than the recorded baseline.
- **`docs`** — the agent-facing domain document, at `.orangerail/generated/AGENTS.md`.
- **`approvals`** — the approval queue for staged actions.
- **`audit verify`** — hash-chain verification, cross-checked against the approvals store. Read
  [what the audit log proves](./docs/audit-log.md) before relying on it as a security control.
- **`studio`** — the live, read-only map of your domain graph.

Everything runs from your repository alone — no external exports, no accounts, no keys.

## Wire it into your agent host

`orangerail mcp` is a **stdio** MCP server. There is no daemon and nothing to toggle: the host
spawns it as a child process, speaks JSON-RPC over its stdin/stdout, and it dies when the host
does. You never start it by hand. (`status`, `approvals` and `audit verify` are ordinary
commands you run in your own terminal, against the same store.)

The `.mcp.json` above is the whole configuration; the equivalent one-liner writes exactly that
file:

```bash
claude mcp add -s project orangerail -e DATABASE_URL="file:./dev.db" \
  -- npx -y orangerail mcp
```

`env` carries whatever your `orangerail.config.mjs` needs to reach your backend. The server
resolves the config from the host's working directory; when that is not your project root, name
it explicitly by appending `"--config", "/abs/path/to/orangerail.config.mjs"` to `args`.

```console
$ claude mcp list
orangerail: npx -y orangerail mcp - ✔ Connected
```

A project-scoped `.mcp.json` is only connected to once you have trusted the directory in the
host; until then the same line reads `⏸ Pending approval`, which is the host asking, not the
config being wrong. As the server comes up it writes one line to stderr (stdout is the JSON-RPC
channel), which lands in your host's log:

```console
orangerail mcp: serving · governance active · 6 action(s) approval-gated · matches the recorded baseline · audit chain OK (0 record(s))
```

**From source instead.** To run an unreleased change, clone this repo, `pnpm install && pnpm -r
run build` (`dist/` is not committed), and swap the server object's `command` and `args` for
`"node"` and `["/abs/path/to/orangerail/packages/cli/dist/main.js", "mcp"]`.

If your host has a permission prompt of its own, orangerail can ask it to fire on the writes you
left un-gated — off by default, and with real caveats:
[Also ask the host to prompt](./docs/host-approval-prompt.md).

## Status

`npx orangerail init` runs against your own project today, with no checkout of this repo, and
the API will move before 1.0. All five packages are published from
[`.github/workflows/release.yml`](./.github/workflows/release.yml) over npm's Trusted Publishing,
so each one carries a provenance attestation naming the workflow and commit that built it; there
is no npm token in this repository.

**Upgrade from `0.1.0` if you are on it.** That release published a read `filter` to the agent
and never checked it, so a `<Object>_list` call could read an object type the server never
exposed ([the mechanism](./docs/limits.md#typed-is-not-enforced--where-the-check-actually-lives)).
The fix is in `0.1.2` and lives in `orangerail-mcp`, so upgrading the package applies it with no
re-run of `init`. `0.1.2` also narrows what `filter` accepts and changes what a pending approval
does across the upgrade — both under **Upgrading from 0.1.0** in the
[CHANGELOG](./CHANGELOG.md), worth reading before you bump.

## Docs

- [What orangerail does not govern](./docs/limits.md) — the preconditions, the missing
  capabilities, and where enforcement actually lives.
- [What the audit log proves](./docs/audit-log.md) — the exact bar, why "tamper-evident" is not
  used, when a database-level audit is the better tool, and where to put the store.
- [Against the thing you would do instead](./docs/vs-a-rules-file.md) — the full rules-file
  comparison: every run, the axis where a rules file wins, and the limits of the measurement.
- [How orangerail compares](./docs/comparisons.md) — against `--read-only`, OpenAPI codegen,
  Prisma's own servers and Supabase's.
- [Adopting orangerail against an existing database](./docs/existing-database.md) —
  `prisma db pull` onto a live database, and what Prisma 7 changes.
- [Also ask the host to prompt](./docs/host-approval-prompt.md) — the optional client-side
  prompt on un-gated writes.

## Examples

- [`unattended-queue`](./examples/unattended-queue) — the run at the top of this file, made
  reproducible: the same 15-item queue through a real MCP client, twelve items finishing
  unattended and three deletions becoming approvals. Deterministic, asserted, no API key.
- [`governed-writes`](./examples/governed-writes) — the same gate in isolation, one destructive
  call at a time, with a recorded terminal session.
- [`vs-a-rules-file`](./examples/vs-a-rules-file) — the rules-file comparison made runnable: a
  rules file read the way a real host reads one, project *and* global. Three scenarios, both
  arms executed, every verdict scored off the rows — including the column where the rules file
  wins, which is asserted.

## Development

This repo is built under a deterministic 9-stage gate harness. Every change runs through
[`./scripts/verify.sh`](./scripts/verify.sh) — language, structure, gate self-test, no-LLM,
templates, then typecheck / lint / test / build — and CI runs that script and nothing else, so a
green local run is a green build. Each gate is a readable script in [`scripts/`](./scripts) with
its rules in its own header comment. A hard invariant: no LLM-inference SDK is ever bundled
([`./scripts/check-no-llm.sh`](./scripts/check-no-llm.sh)).

## License

[MIT](./LICENSE)
