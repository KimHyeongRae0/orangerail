# orangerail

> Declare your domain once — and every AI agent that touches it is guided,
> governed, and visible.

**Status: pre-release.** v0 is under active development; the API described below is
the design target, not a published surface. A version stub is published to npm to
hold the name.

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
