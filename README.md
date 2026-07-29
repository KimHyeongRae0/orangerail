# orangerail

> Declare your domain once — and every AI agent that touches it is guided,
> governed, and visible.

**Status: pre-release, and installable.** v0 is on npm at `0.1.0` — `orangerail` (the
CLI) plus `orangerail-core`, `orangerail-mcp`, `orangerail-docs-gen` and
`orangerail-studio`. `npx orangerail init` runs against your own project today, with no
checkout of this repo ([Quickstart](#quickstart)). It is still v0 and under active
development: the API described further down is the design target, and it will move before
1.0.

## See it stop an agent

A real MCP client (the same kind an agent host uses) tries a destructive delete. The
server shows up and blocks it — and the agent cannot force it through. Only after a
human decides does it run, on a verifiable audit chain.

![orangerail blocks a destructive agent action, then runs it only after a human approves](./examples/governed-writes/demo.gif)

This is one real run of
[`examples/governed-writes/walkthrough.mjs`](./examples/governed-writes) — run it yourself:

```console
THE AGENT SIDE — a real MCP client tries to delete, and gets blocked
[host log]    orangerail mcp: serving · governance active · 6 action(s) approval-gated · audit chain OK (4 record(s))
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

**1. Scan your project.** Run this in a repo that has a `prisma/schema.prisma` or an
OpenAPI spec. The scanner is deterministic: it reads your files, makes no LLM calls, and
needs no API key. `--yes` takes the defaults instead of prompting, and `--no-studio` keeps
the run in the terminal.

```console
$ npx orangerail init --yes --preset approval-for-writes --no-studio
  ✓  scanned your sources — 2 object(s), 6 action(s)
  ✓  generated a governed MCP server under ontology/
  ✓  6 write action(s) gated behind human approval

  These files are yours — re-scans never modify them; `orangerail sync` reports drift.

Next step: install the runtime deps so the generated code can load:
  npm install orangerail-core zod
Then run `orangerail studio` or `orangerail mcp`.
```

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
  preset:   approval-for-writes
  pending:  0 approval(s) awaiting a decision
  server:   not detected — no orangerail mcp is running against this store
  audit:    chain OK — 0 record(s) verified
```

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
  preset:   approval-for-writes
  pending:  1 approval(s) awaiting a decision
  server:   not detected — no orangerail mcp is running against this store
  audit:    chain OK — 1 record(s) verified

$ npx orangerail approvals approve dff95d9d-8237-407a-b80b-c47252d56a1f
approve ok (approved)
```

The agent's next `check_approval` is the first moment the row can change. Nothing ran
before you said so, and every step is on the hash chain.

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

## What orangerail will be

The domain rules you've been hand-writing into scattered markdown — product
statuses, order invariants, "never issue a coupon for a sold-out item" — declared
once in TypeScript (zod-native), and compiled into the three things an AI agent
working against your system actually needs:

- **A prompt rail** — generated domain docs for `AGENTS.md`, so agents are *guided*
  to behave well.
- **A runtime rail** — a typed MCP server with staged write-actions, human-in-the-loop
  approval, and a tamper-evident audit log, so agents are physically *stopped* when
  they don't.
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
  baseline you record with `orangerail sync --accept-governance`), so a removed
  approval gate fails the run instead of passing as "in sync". Exit 1 on drift.
- `orangerail mcp` — typed MCP server over your declared objects, links, and actions.
- `orangerail approvals` — CLI approval queue for staged actions.
- `orangerail audit verify` — hash-chain verification of the audit log.
- `orangerail studio` — the live, read-only map of your domain graph.

Everything here runs from your repository alone — no external exports, no accounts,
no keys. Point it at your own code and it works.

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
orangerail mcp: serving · governance active · 6 action(s) approval-gated · audit chain OK (0 record(s))
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
