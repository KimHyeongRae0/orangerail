# orangerail-mcp

Generate a governed [MCP](https://modelcontextprotocol.io) server from an
ontology registry. This is the **only** orangerail package that depends on
`@modelcontextprotocol/sdk` (NOLLM-01 scope rule).

`createMcpServer({ registry, store, resolveIdentity?, preset?, redactAudit? })`
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

## Caveats

- **Approved-but-never-repolled**: v0 has no approval expiry. An approved
  approval the agent never re-polls via `check_approval` simply never executes —
  it sits `approved` in the store indefinitely (visible via `orangerail approvals`).
- **Plaintext storage**: staged inputs, results, and errors are stored in
  plaintext by default (see `orangerail-core`). Supply `redactAudit` to mask
  audit records; do not put secrets in action inputs.
- **Config is code**: loading an ontology config is arbitrary code execution
  (same trust level as an npm script); v0 is stdio only, no network exposure.
