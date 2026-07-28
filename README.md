# orangerail

> Declare your domain once — and every AI agent that touches it is guided,
> governed, and visible.

**Status: pre-release.** v0 is under active development; the API described below is
the design target, not a published surface. A version stub is published to npm to
hold the name.

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
const issueCoupon = defineAction({
  name: 'issueCoupon',
  target: Product,
  input: z.object({ productId: z.string(), amount: z.number() }),
  policy: {
    approval: 'required',
    audit: true,
    where: { field: 'status', op: 'neq', value: 'soldout' },
  },
  execute: async ({ productId, amount }) => {
    /* your existing backend call */
  },
});
```

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

## Examples

Runnable, end-to-end examples live in [`examples/`](./examples). Each runs orangerail
on a single concept and proves the behaviour with real output:

- [`governed-writes`](./examples/governed-writes) — a destructive write stays
  available to an agent but is staged for human approval instead of executing, on a
  verifiable audit chain. Resolves the read-only-vs-write dilemma.

## Development

This repo is built under a deterministic 9-stage gate harness. Every change runs
through `./scripts/verify.sh` (language + structure + gate self-test + no-LLM +
templates + typecheck/lint/test/build) and a per-ticket TDD loop. See
[`docs/WORKFLOW.md`](./docs/WORKFLOW.md) for the full workflow and
[`CLAUDE.md`](./CLAUDE.md) for project instructions and layout. A hard invariant:
no LLM-inference SDK is ever bundled (`./scripts/check-no-llm.sh`).

## License

[MIT](./LICENSE)
