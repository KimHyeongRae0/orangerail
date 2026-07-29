# Example: governed writes

**The dilemma this resolves.** When you give an AI agent tools over your database,
destructive operations (delete a row, apply a migration, change state) come along
for the ride. The common guardrail is a single **read-only switch**: flip it on and
the agent is safe but can no longer do the writes you actually wanted; flip it off
and every destructive tool executes the moment the model decides to call it. Worse,
in many servers a destructive tool still appears in the tool list even in read-only
mode, so the agent plans around a capability it is not allowed to use — a false
signal. This binary is the exact gap discussed across several database/API MCP
servers ("add your own approval/guardrails — that's out of scope").

Orangerail removes the binary. A write stays **available** to the agent, but calling
it **stages the operation for human approval** instead of executing it: the tool
returns an `approvalId`, a human approves out of band, and only then does it run —
with every executed write recorded on a hash-chained audit log that `orangerail audit
verify` checks against itself and against the approvals store. That log is an audit
trail behind a human checkpoint, not a tamper-evident boundary against someone who can
write the store directory — the limit is stated exactly in
[What the audit log proves](../../README.md#what-the-audit-log-proves).

This example is a tiny content database (`Article`, `Comment`). `deleteArticle` is
the destructive tool.

## Watch the interception (`walkthrough.mjs`)

`walkthrough.mjs` runs the whole story end to end, from both sides of the moment
governance kicks in — using a **real MCP client** (`@modelcontextprotocol/sdk`, the
same client an agent host uses) and the **real** approval CLI. Nothing mocked; every
step is asserted (it exits non-zero on any failure), so it is a real e2e:

![the governed-writes walkthrough running](./demo.gif)

```
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
   [human]       $ orangerail approvals list
   fdbb4b96-…  "deleteArticle"  by "local-dev" [dev]  input={"id":13}
   [human]       I recognize this, it's fine → approvals approve fdbb4b96…

BACK TO THE AGENT — only now does it run
[agent]       check_approval again → "executed"
[db check]    article 13: gone
[human]       $ orangerail audit verify → audit chain OK — 8 record(s) verified.
```

Three things this proves that a read-only switch cannot: the destructive tool stays
**available** (not hidden), the agent **cannot force it through** on its own, and the
row changes **only after a human decided** — all on a verifiable audit chain.

## Run it

From a repo checkout. This folder resolves `orangerail-*` from the monorepo workspace
rather than from npm, so it runs against your working tree — that is deliberate, it is how
a change to `packages/` shows up in the walkthrough immediately. (To run orangerail on your
own project instead, no checkout is involved: see the
[Quickstart](../../README.md#quickstart).)

**Build the workspace first.** The walkthrough spawns the real CLI at
`packages/cli/dist/main.js`, and `dist/` is not committed — on a fresh clone it does not
exist yet. Skip this and the walkthrough dies on an opaque
`McpError: MCP error -32000: Connection closed`, because the server it spawned was a
missing file:

```bash
pnpm install && pnpm -r run build                  # at the REPO ROOT
```

Then the example itself:

```bash
cd examples/governed-writes
npm install                                        # prisma + the MCP client
export DATABASE_URL="file:./dev.db"
npx prisma generate --schema prisma/schema.prisma  # generate the client
npx prisma db push  --schema prisma/schema.prisma  # create the SQLite DB

node walkthrough.mjs                               # the full story, asserted
```

To explore the same ontology visually: `node ../../packages/cli/dist/main.js studio`.

To drive this ontology from a real agent host instead of the scripted walkthrough, see
[Wire it into your agent host](../../README.md#wire-it-into-your-agent-host) and take its
from-source form — the same `dist/main.js` from the build above, spawned over stdio by the
host. The `npx` form there is for your own project, which resolves the packages from npm;
this folder resolves them from the workspace.

## Is it actually protecting me?

You don't need a live dashboard to tell. `orangerail status` prints the posture —
how many actions are approval-gated, whether the audit chain verifies, and what is
waiting on a human:

```
orangerail status
  objects:  2
  actions:  6 approval-gated, 0 auto
  preset:   approval-for-writes
  pending:  0 approval(s) awaiting a decision
  server:   running (pid 40321, started 12s ago)
  audit:    chain OK — 4 record(s) verified
```

The `server:` line is a genuine liveness signal, not a re-derivation from config: it reads
a heartbeat each serving process writes, so it distinguishes a live, enforcing server
(`running`) from a crashed one (`stale`) or none at all (`not detected`). It tracks **every
server sharing this store**, one heartbeat entry per process, so running two against the
same store reports both — and one of them shutting down never erases the other:

```
  server:   running (2 servers — pid 77724 started 1s ago, pid 77725 started 0s ago)
  server:   running (pid 77725, started 1s ago)          # after the first one exits
```

`running` requires a live pid **and** a fresh heartbeat, so a crashed server's leftover
entry can only ever downgrade the line (to `stale`, alongside any server still serving) —
it can never manufacture a `running` claim for a process that is gone.

The MCP server also writes a one-line confidence signal to stderr the moment it starts
(stdout is the JSON-RPC channel), so your agent host's logs show governance is wired
and the server is up:

```
orangerail mcp: serving · governance active · 6 action(s) approval-gated · audit chain OK (4 record(s))
```

A broken audit chain is surfaced loudly in both places, and `orangerail status` exits
non-zero so a script can gate on it.

## How it is wired

- `prisma/schema.prisma` — the domain (`Article` → `Comment`).
- `ontology/*.mjs` — generated by `orangerail init`; **these files are yours** (edit
  the policies, add `where` guards). `deleteArticle` carries `policy:
  { approval: 'required' }`, which is what stages it.
- `orangerail.config.mjs` — self-discovers `ontology/*.mjs`, wires a file store, and
  uses the `approval-for-writes` preset. It opts into `allowDevMode` for a
  single-user local run; before exposing the server to anyone else, add a
  `resolveIdentity` adapter and remove that flag. The store is
  `createFileStore({ dir: join(here, '.orangerail', 'store') })` — inside this folder,
  which is right for a scripted walkthrough and wrong for a real agent that has file
  tools over the repo. See
  [Keep the store out of the agent's reach](../../README.md#keep-the-store-out-of-the-agents-reach).

## Honest caveat

This folder is wired to the monorepo, not to the registry: it resolves `orangerail-core`
and the CLI from the workspace and spawns `packages/cli/dist/main.js` by path. So copying
the folder somewhere on its own will not work — the walkthrough needs a built checkout
around it.

That is a property of the example, not of orangerail. The packages are published
(`orangerail`, `orangerail-core`, `orangerail-mcp`, `orangerail-docs-gen`,
`orangerail-studio`, all at `0.1.0`), and `npx orangerail init` sets the same governance up
on your own project without cloning anything — the
[Quickstart](../../README.md#quickstart) is that path end to end.
