# orangerail

> Declare your domain once — and every AI agent that touches it is guided,
> governed, and visible.

**Status: pre-release.** v0 is under active development; the API described below is
the design target, not a published surface. **Nothing is published to npm yet** —
`npx orangerail` will 404, and so will every `orangerail-*` package. The only way to
run it today is to build it from source in a checkout (see
[Wire it into your agent host](#wire-it-into-your-agent-host)).

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

Build it first — nothing is on npm, and `dist/` is not committed:

```bash
git clone https://github.com/KimHyeongRae0/orangerail.git
cd orangerail
pnpm install && pnpm -r run build     # produces packages/cli/dist/main.js
```

Then point the host at that file. For Claude Code, a `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "orangerail": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/orangerail/packages/cli/dist/main.js", "mcp"],
      "env": { "DATABASE_URL": "file:./dev.db" }
    }
  }
}
```

Or the equivalent one-liner:

```bash
claude mcp add -s project orangerail -e DATABASE_URL="file:./dev.db" \
  -- node /abs/path/to/orangerail/packages/cli/dist/main.js mcp
```

`env` carries whatever your own `orangerail.config.mjs` needs to reach your backend — the
`DATABASE_URL` above is what the Prisma example uses. The server resolves the config from
the host's working directory; when that is not your project root, name it explicitly by
appending `"--config", "/abs/path/to/orangerail.config.mjs"` to `args`. Verify with
`claude mcp list` — a healthy wiring reports `✔ Connected`, and the server writes one line
to stderr as it comes up (stdout is the JSON-RPC channel), which lands in your host's log:

```console
orangerail mcp: serving · governance active · 6 action(s) approval-gated · audit chain OK (4 record(s))
```

Once packages are published this becomes `"command": "npx"`, `"args": ["-y",
"orangerail", "mcp"]` — **that form does not work yet**; nothing is on npm.

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
