# Commands

Everything runs from your repository alone — no external exports, no accounts, no keys.

## `init`

A deterministic scanner that extracts your ontology from code instead of asking you to type it.
**No LLM calls, no API keys — ever.**

A `prisma/schema.prisma` is the input the README describes: objects with their relations, a `get`
and a `list` per object, one runnable action per write.

**An OpenAPI spec gives you a scaffold, not a server.** The current release reads JSON only — a
`.yaml` spec is refused with a convert-it hint rather than parsed. Every `GET` is skipped and no
objects are derived, so there is **no read surface at all**; what you get is one action per
non-GET operation, with a zod input schema built from the request body and `execute: notImplemented`
for you to wire up. That is real work saved on the input schemas and the policy wiring, and it is
not an MCP server you can hand an agent as-is. The reason it is thinner is structural rather than
neglect: an OpenAPI spec carries no relation graph to derive objects from
([comparisons](./comparisons.md)).

### Choosing what is gated

`--gate delete` is the default, and it is the line worth pausing on. Gating *every* write is the
safer-sounding default and is what orangerail shipped first — but a surface where nothing completes
without a human is a surface nobody leaves running. So `init` gates the op whose name most reliably
predicts a row is gone, and lets the rest through. That is a starting point, not a verdict:
`create` can be the most consequential write a schema has. Pass `--gate all`, `--gate none`, or
edit `policy` per file afterwards.

### Narrowing the surface

Narrowing is the point, so `orangerail init --models customer,order` leaves your `payment` and
`api_credential` tables out of the ontology entirely. Record that decision, or every later `sync`
rediscovers them and exits 1 — with `--accept-new`, the remedy that would generate them, as the
only fix it can name:

```bash
npx orangerail init --exclude api_credential,payment      # or: orangerail sync --exclude …
```

That writes those names into `orangerail.governance.json` as **considered and refused**, so `sync`
reports them as `info:` and the run can be green. It is a list of names, not a snapshot: a table
appearing *after* the refusal is still reported loudly, and a recorded name that stops matching
anything is reported as prunable, so it cannot quietly silence a future table that reuses it. Both
flags match your sources ignoring case and write back the name your sources declare; a typo, a
prefix or a plural is refused, naming the models you do have.

**orangerail will never guess which tables those are.** It does not scan for `secret`, `password`
or `credential` and pre-select the matches. A name is syntactic and the danger it stands for is not
— the table that puts a customer's card number in a support transcript is called `payment` — and a
tool that pre-checks the boxes is a tool whose list you stop reading. You name each one.

## `sync`

Re-scan and report drift, including a weakened governance posture. Exit **0** for nothing to act
on, **1** for unresolved drift, **2** when it could not answer at all.

## `mcp`

The typed MCP server, withholding any action weaker than the recorded baseline. See
[wiring it into your agent host](./agent-hosts.md).

## `docs`

The agent-facing domain document, at `.orangerail/generated/AGENTS.md`.

## `approvals`

The approval queue for staged actions — `list`, `approve`, `reject`.

## `audit verify`

Hash-chain verification, cross-checked against the approvals store. Read
[what the audit log proves](./audit-log.md) before relying on it as a security control.

## `studio`

The live, read-only map of your domain graph.
