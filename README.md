# orangerail

> Declare your domain once — get both the docs and the enforcement for AI agents.

**Status: pre-release.** v0 is under active development; the API described below is
the design target, not a published surface. A version stub is published to npm to
hold the name.

## What orangerail will be

The domain rules you've been hand-writing into markdown — product statuses, order
invariants, "never issue a coupon for a sold-out item" — declared once in TypeScript
(zod-native), compiled into two rails:

- **Prompt rail** — generated domain docs for `AGENTS.md`, so agents are guided to
  behave well.
- **Runtime rail** — a typed MCP server with staged write-actions, human-in-the-loop
  approval, and a tamper-evident audit log, so agents are physically stopped when
  they don't.

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
  ontology instead of asking you to type it. No LLM calls, no API keys — ever.
- `orangerail mcp` — typed MCP server over your declared objects, links, and actions.
- `orangerail approvals` — CLI approval queue for staged actions.
- `orangerail audit verify` — hash-chain verification of the audit log.
- `orangerail studio` — a live, read-only map of your domain graph.

## Development

This repo is built under a deterministic 9-stage gate harness. Every change runs
through `./scripts/verify.sh` (language + structure + gate self-test + no-LLM +
templates + typecheck/lint/test/build) and a per-ticket TDD loop. See
[`docs/WORKFLOW.md`](./docs/WORKFLOW.md) for the full workflow and
[`CLAUDE.md`](./CLAUDE.md) for project instructions and layout. A hard invariant:
no LLM-inference SDK is ever bundled (`./scripts/check-no-llm.sh`).

## License

[MIT](./LICENSE)
