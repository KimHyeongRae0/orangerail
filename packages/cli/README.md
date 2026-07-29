# orangerail

The `orangerail` command-line interface: the human-facing approval and audit
surface, plus the MCP server launcher. Hand-rolled argument parsing, zero
runtime third-party dependencies (reaches the MCP server through the workspace
dep `orangerail-mcp`, never a direct SDK dependency).

## Configuration

Every command loads an ontology config — a default export
`{ registry, store, resolveIdentity?, preset?, redactAudit? }` — from
`orangerail.config.mjs` (or `.js`, `.ts`, `.mts`, or `--config <path>`) via
plain dynamic `import()`. TypeScript configs work through your own TS-capable
runtime (`tsx`, or `node --experimental-strip-types`); orangerail does not
bundle a loader. Every command discovers the same four names, `init` included —
it refuses rather than regenerate over an ontology whose config is a `.ts`.

Loading a config is **arbitrary code execution** (same trust level as an npm
script) — run only configs you trust.

## Commands

```
orangerail mcp [--config <path>]                  launch the MCP server over stdio
orangerail approvals list [--config <path>]       list pending approvals
orangerail approvals show <id> [--full] [--config <path>]
                                                  show one approval (--full: uncapped input)
orangerail approvals approve <id> [--config …]    approve a staged action (CAS)
orangerail approvals reject <id> [--config …]     reject a staged action (CAS)
orangerail audit verify [--config <path>]         verify the audit chain
orangerail store unlock [--config <path>]         clear a provably-dead store lock
```

`approvals list` renders the approver decision surface: full id, action,
`requestedBy` (with a `[dev]` marker in dev mode), age, and a one-line input
preview. Every agent-supplied string is stripped of ANSI/control characters and
JSON-escaped before it reaches the terminal (approval-deception defense) — the
staged input is always labeled agent-supplied. Bidi and invisible-formatting
code points (`U+202E` and the rest of the Trojan Source class, the zero-width
characters, the TAG block) are escaped to a visible `\uXXXX` rather than
deleted, so a hostile string can neither reorder the line nor pass as a clean
one.

`approvals show` caps the staged input so the decision context (`id`, `action`,
`status`, `requestedBy`) always stays on screen — a 1 MB input would otherwise
scroll it away. The truncation states exactly how much was withheld; pass
`--full` to print the whole value.

## Identity and dev mode

`approve` / `reject` resolve the caller with `resolveCaller({ transport: 'cli',
request: { osUser } })`. A config `resolveIdentity` adapter maps the OS user to
`{ subject, roles }` (role mapping lives in the config). With no adapter the
local CLI runs in **dev mode**: the `local-dev` identity approves anything and
stamps `devMode: true` into audit records.

## Store lock recovery

If a process died inside the file store's critical section, the store stays
locked (the runtime never steals a lock). Run `orangerail store unlock` when no
orangerail process is running — it clears the lock only when the owner pid is
provably dead, and refuses a live/ambiguous owner or a missing `owner.json`. As
a last resort, `rm -r <store-dir>/lock` while no orangerail process runs.

## Storage warning

Approvals and audit records store action inputs — and audit records also
results and error messages — in plaintext by default. Supply `redactAudit` in
the config to mask audit records (approval records persist verbatim by design);
do not put secrets in action inputs.
