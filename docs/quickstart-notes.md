# Quickstart, annotated

The README's [Quickstart](../README.md#quickstart) is the seven steps with nothing between them.
This page is what each one is actually doing, and the failure each one prevents. It is the same
run: every output on both pages is verbatim from the `0.1.3` packages installed with
`npm i -D orangerail`, in a scratch directory holding nothing but a two-model Prisma schema
(`Customer`, `Order`) and Prisma 6.

## Requirements

**Node 20 or newer** for the `orangerail` CLI and `orangerail-mcp` (Node 18 for `orangerail-core`,
`orangerail-docs-gen` and `orangerail-studio` on their own).

**On Prisma 7, two things stop you before orangerail is reached** — a `url` in the `datasource`
block now fails every `prisma` command, and the client requires a driver adapter, without which
`init` exits 1 rather than generate an ontology that cannot construct a client. Both moves, and
which adapter your provider needs, are in
[Adopting orangerail against an existing database](./existing-database.md#prisma-7).

## 1. Why install rather than `npx -y`

`npx` fetches a copy of its own, carrying its own `orangerail-core`, while your project resolves a
second one, and every `orangerail status` from then on opens with a `runtime:` block reporting two
copies loaded. Writes still complete under it — that is a hazard rather than a fault — and it is
avoidable, which is why the Quickstart takes the path that avoids it. What the block means and how
to clear one you already have is in
[two copies of `orangerail-core`](./troubleshooting.md#two-copies-of-orangerail-core).

## 2. What `init` reads, and the fourth checkmark

Run it in a repo with a `prisma/schema.prisma`. Live database and no schema file? `prisma db pull`
writes one — the whole path is in
[Adopting orangerail against an existing database](./existing-database.md). An OpenAPI spec is also
accepted and yields considerably less — see [what the OpenAPI input gives you](./commands.md#init).

The fourth `✓` is there because of step 1. `init` reads the baseline off the **live registry** —
never off the generated text — so it has to import the config it just wrote, and that import needs
`orangerail-core` resolvable from the project. Installing orangerail locally puts one there. Scan
through `npx -y orangerail` on a project with nothing installed and the same line reads
`⚠ no governance baseline recorded — the generated config did not load` instead. Either way it is
the posture `init` generated and nobody has reviewed; step 6 is what changes that.

Which writes are gated, and how to change it, is under [`init`](./commands.md#init).

## 3. Why name `orangerail-core` and `zod` explicitly

On the recorded run npm answered `up to date`: both already resolved, hoisted out of `orangerail`'s
own dependency tree by step 1. Name them anyway — they are what your `ontology/*.mjs` files import
directly, a hoist is a layout decision npm is free to change, and pnpm's default layout does not
produce one at all.

## 4. The step whose absence costs you a human decision

`@prisma/client` has to match the major of the `prisma` CLI already in your project; the Quickstart
is on Prisma 6, which is what the `@6` pins. `generate` writes the client the generated actions
import; `db push` creates `dev.db` and its tables — `--skip-generate` only because the line above
it already generated.

**Skip this step and the payoff at step 7 never arrives.** The generated actions import
`@prisma/client` lazily, so `init`, `sync` and `status` all stay green and nothing says a word
until the agent calls a write. Then every write fails with `the datasource client is not installed
or has never been generated` — and on a *gated* one it fails after the approval has been consumed:
`orangerail approvals list` reads `No pending approvals.` afterwards, and the row is untouched. The
human decision was spent on a write that never happened, and has to be made a second time.

**Already have a database? Do not `db push` over it.** `prisma db pull` writes a schema from the
tables that are already there, and the whole path — including what Prisma 7 changes — is in
[Adopting orangerail against an existing database](./existing-database.md). `npm install
@prisma/client` and `npx prisma generate` are still yours to run; only the `db push` is replaced.

## 5. Pointing the host at it

Why `command` names the binary directly rather than `npx`, how `env` reaches your backend, and the
`claude mcp add` one-liner that writes the same file: [wire it into your agent
host](./agent-hosts.md).

## 6. Why the baseline is a committed file

`ontology/` is yours to edit, which means the one line that disarms the whole flow
(`policy: { approval: 'required' }`) is one careless deletion away, and a re-scan cannot notice:
the scanner has no opinion on policy. So the posture is compared against a recorded file.

`sync --accept-governance` rewrites `orangerail.governance.json` at your repo root: one row per
action holding its approval gate, approver roles, `where` guard and target. **Commit it.** Its
whole value is that a pull request removing an approval gate shows `"approval": "required"` turning
into `null` in its own diff, in front of a reviewer, before CI runs at all.

Step 2 already wrote the file — `init` does whenever the generated config loads — stamped
`"recordedBy": "init"`, the posture init *generated*, before anyone reviewed it.
`--accept-governance` re-records it as `"recordedBy": "sync"`, the human assertion.

From then on `orangerail sync` exits 1 when the posture weakens, and `orangerail mcp` refuses to
serve the weakened action — not listed, not resolvable, not executable, while everything else is
served. What that does and does not defend against is in
[the limits doc](./limits.md#what-the-governance-baseline-defends-against).

## 7. The store is inside your project, and that matters

The `store:` line on every `orangerail status` says so on purpose. The approvals queue and audit
chain live at `.orangerail/store/`, inside the project root, so **an agent with file tools over
this directory can write them**: one appended line in `approvals.jsonl` is a decision no human
made, and the next `check_approval` executes the staged action, because the gate reads that store
and never the audit chain. `orangerail audit verify` reports the forgery afterwards; it is a
report, not a gate, and it does not prevent the write.

Pointing the store `dir` at a directory the agent's process cannot write is what removes the reach
— the one-line move is at the `createFileStore` call, and it is in
[Keep the store out of the agent's reach](./audit-log.md#keep-the-store-out-of-the-agents-reach).

`hosts:` on the same readout names every MCP server declared in the project's own client config
(`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`) that is not this project's `orangerail mcp`,
because a second route to the same database is the precondition orangerail cannot enforce. User-
and machine-scope MCP config is not read.

## What is asserted

The commands on the README's Quickstart page, executed in the order written, ending in a row that
is gone, is what
[`tests/e2e/ONT-093-quickstart-runs-as-documented.sh`](../tests/e2e/ONT-093-quickstart-runs-as-documented.sh)
runs against this repository's own build on every regression pass. If the Quickstart drifts from
what actually works, that scenario goes red.
