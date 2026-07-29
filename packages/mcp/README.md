# orangerail-mcp

Generate a governed [MCP](https://modelcontextprotocol.io) server from an
ontology registry. This is the **only** orangerail package that depends on
`@modelcontextprotocol/sdk` (NOLLM-01 scope rule).

`createMcpServer({ registry, store, resolveIdentity?, preset?, redactAudit?,
reportFailure? })`
returns `{ server, serve }` and uses the low-level `Server` with explicit
`tools/list` + `tools/call` handlers (not `McpServer.registerTool`, not the
experimental tasks API), so input validation stays in exactly one place — the
core engine.

## Tools

- `<object>_get` / `<object>_list` — one per object with a `resolve` contract.
  Objects with `readAccess: 'authenticated'` deny anonymous callers.
- `<actionName>` — one per action. A policy-gated action **stages** and returns
  structured `{ status: 'approval_pending', approvalId }`; the agent must poll
  `check_approval` to complete it.
- `check_approval` — the re-check surface. `pending` / `rejected` report status;
  an `approved` approval is **executed in this server process** and the result
  returned; `consumed` reports consumed (idempotent re-poll).

Tool names are validated against `^[a-zA-Z0-9_-]{1,64}$` and checked for
collisions at build time (fail fast).

## Presets

- `approval-for-writes` (default) — actions exposed as declared.
- `sandbox` — engine `dry_run` mode; actions return `dry_run`, never execute.
- `readonly` — no action tools, no `check_approval`.

## Identity and dev mode

Stdio callers are resolved with `resolveCaller({ transport: 'stdio' })`. With no
`resolveIdentity` adapter, the local server runs in **dev mode**
(`allowDevMode: true`): the synthetic `local-dev` identity is used and every
audit record it produces is stamped `devMode: true`. Remote transports (post-v0)
MUST pass `allowDevMode: false`.

## Error redaction

A datasource error is never forwarded to the agent. orangerail sits between the
agent and the datasource precisely so that surface is controlled, and a raw
Prisma/driver message names tables, constraint names, query text, and absolute
file paths.

Every failing path — a throwing action `execute`, a throwing read resolver, a
blocked audit append, any other throw out of `tools/call` — returns:

```json
{
  "status": "failed",
  "correlationId": "6f1d0d2e-…"
}
```

with a message naming the tool, the domain-level cause (`the action ran and the
datasource rejected it` / `the action target could not be read from the
datasource` / `the audit record could not be written, so nothing was executed` /
`the server hit an unexpected internal error`), and that same id. The agent
keeps enough to decide whether to retry, choose another tool, or escalate — it
just never learns the schema.

The FULL text goes to the operator instead:

- **`reportFailure`** — defaults to **stderr** (on stdio, stdout is the JSON-RPC
  channel). Pass your own sink to route it into a host logger:
  `reportFailure: ({ status, tool, correlationId, error }) => log.error(…)`.
- **the audit record** — `failed` and `resolve_error` records carry the full
  `error`, keyed by the same `correlationId` the agent was handed
  (`approvalId` on the approval path). An `audit_blocked` failure is the append
  itself failing, so for that one the sink is the only copy.

## Caveats

- **Approved-but-never-repolled**: v0 has no approval expiry. An approved
  approval the agent never re-polls via `check_approval` simply never executes —
  it sits `approved` in the store indefinitely (visible via `orangerail approvals`).
- **Plaintext storage**: staged inputs, results, and errors are stored in
  plaintext by default (see `orangerail-core`). Supply `redactAudit` to mask
  audit records; do not put secrets in action inputs. The audit log is an
  operator artifact — it holds the unredacted failure text on purpose.
- **Config is code**: loading an ontology config is arbitrary code execution
  (same trust level as an npm script); v0 is stdio only, no network exposure.
