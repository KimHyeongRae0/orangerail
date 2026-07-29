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
  returned; `consumed` reports consumed (idempotent re-poll). Under the `sandbox`
  preset it records a `dry_run` instead — see Presets.

Tool names are validated against `^[a-zA-Z0-9_-]{1,64}$` and checked for
collisions at build time (fail fast).

## Presets

- `approval-for-writes` (default) — actions exposed as declared.
- `sandbox` — engine `dry_run` mode; actions return `dry_run`, never execute.
  This covers `check_approval` too: the engine refuses **before** the consume CAS,
  so a sandbox server sharing a store with a live one neither executes an approval
  the live server staged nor burns it — the approval stays `approved` and the live
  engine still completes it. The destructive tool stays visible and simply cannot
  cause an effect, which is the same design as an approval gate.
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

with a message naming the tool, the domain-level cause, the kind of error being
withheld, and where an operator can find it:

> Tool "update_order" failed: the datasource rejected the action. The datasource
> error is withheld; an operator can read it in the audit log or host log under
> correlationId "6f1d0d2e-…".

The agent keeps enough to decide whether to retry, choose another tool, or
escalate — it just never learns the schema.

The message is held to the same honesty standard as the rest of the project: it
says what KIND of error was withheld (a **store** error for `audit_blocked`, not
a datasource one) and names **only a channel that actually holds the text**:

| status           | cause                                                       | withheld         | where              |
| ---------------- | ----------------------------------------------------------- | ---------------- | ------------------ |
| `failed`         | the datasource rejected the action                            | datasource error | audit log or host log |
| `resolve_error`  | the target could not be read from the datasource              | datasource error | audit log or host log¹ |
| `audit_blocked`  | the audit record could not be written, so nothing ran         | store error      | host log           |
| `internal_error` | an unexpected internal error                                  | underlying error | host log           |

¹ a `resolve_error` raised by a **read tool** says host log only — reads are not
audited by design, and pointing an operator at a record that cannot exist is the
same class of error as leaking one.

### Classified configuration failures

Redaction is absolute about the datasource's own words, and that used to make
orangerail's own first-run diagnostics disappear along with them: an agent whose
project simply had no `DATABASE_URL` was told "the datasource rejected the
action", which it cannot act on.

So a failure orangerail can positively identify carries a **classification**
rather than a message. The failing layer attaches a code from a closed set; this
package owns the sentence for each code:

| `diagnostic`                 | what actually happened                          |
| ---------------------------- | ------------------------------------------------ |
| `datasource_client_missing`  | `@prisma/client` is not installed or not generated |
| `datasource_model_missing`   | the client was generated from a different schema   |
| `datasource_not_configured`  | the connection URL is missing or unusable          |

```json
{
  "status": "failed",
  "diagnostic": "datasource_not_configured",
  "correlationId": "6f1d0d2e-…"
}
```

> Tool "createNote" failed: the datasource is not configured, so the client could
> not connect. Its connection URL is missing or unusable — for a Prisma project
> that is the DATABASE_URL environment variable, which must be set for the
> process running the orangerail server. Set it, then retry. The datasource error
> is withheld; an operator can read it in the audit log or host log under
> correlationId "6f1d0d2e-…".

This is not a hole in the redaction, and it is worth being precise about why.
The channel carries **no string** from the failing layer: a `code` from a closed
enum, plus an optional `subject` that must match `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`
and is dropped otherwise. The prose lives here, in the transport. A datasource
that forged the marker could therefore achieve exactly one thing — making
orangerail print one of orangerail's own sentences. The driver text is still
withheld, and the message still says so. Anything orangerail cannot classify
carries no `diagnostic` at all and is redacted exactly as before.

The FULL text goes to the operator instead:

- **`reportFailure`** — runs on every failure path, so the host log always has
  it. Defaults to **stderr** (on stdio, stdout is the JSON-RPC channel). Pass
  your own sink to route it into a host logger:
  `reportFailure: ({ status, tool, correlationId, error }) => log.error(…)`.
- **the audit record** — engine-raised `failed` / `resolve_error` records carry
  the full `error`, keyed by the same `correlationId` the agent was handed
  (`approvalId` on the approval path).

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
- **The audit log is an audit trail behind a human checkpoint, not a
  tamper-evident boundary.** `verifyAudit` cross-checks the chain against the
  approvals store, but the chain hash is unkeyed and its anchor is unsigned and
  sits in the same directory, so an attacker who can write the store can rewrite
  both logs consistently. Put the store somewhere the governed agent cannot write
  — `orangerail init` scaffolds it inside the scanned project by default. Stated
  exactly under
  [What the audit log proves](https://github.com/KimHyeongRae0/orangerail#what-the-audit-log-proves).
