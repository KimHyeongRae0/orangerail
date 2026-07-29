# orangerail

> Declare your domain once — and every AI agent that touches it is guided,
> governed, and visible.

**Status: pre-release, and installable.** v0 is on npm at `0.1.0` — `orangerail` (the
CLI) plus `orangerail-core`, `orangerail-mcp`, `orangerail-docs-gen` and
`orangerail-studio`. `npx orangerail init` runs against your own project today, with no
checkout of this repo ([Quickstart](#quickstart)). It is still v0 and under active
development: the API described further down is the design target, and it will move before
1.0. What has changed since `0.1.0`, and the one thing an upgrade asks of you, are in the
[CHANGELOG](./CHANGELOG.md).

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

## Quickstart

The shortest true path from zero to watching an agent get blocked. Every output below is
verbatim from one run against the published `0.1.0` packages, in a scratch project holding
nothing but a two-model Prisma schema (`Customer`, `Order`) — no checkout of this repo,
nothing built from source.

**1. Scan your project.** Run this in a repo that has a `prisma/schema.prisma` or an
OpenAPI spec. The scanner is deterministic: it reads your files, makes no LLM calls, and
needs no API key. `--yes` takes the defaults instead of prompting, and `--no-studio` keeps
the run in the terminal.

```console
$ npx orangerail init --yes --preset approval-for-writes --no-studio
  ✓  scanned your sources — 2 object(s), 6 action(s)
  ✓  generated a governed MCP server under ontology/
  ✓  6 write action(s) gated behind human approval

  These files are yours — re-scans never modify them; `orangerail sync` reports drift.

Next step: install the runtime deps so the generated code can load:
  npm install orangerail-core zod
Then run `orangerail studio` or `orangerail mcp`.
```

**2. Install the runtime the generated code loads.**

```bash
npm install orangerail-core zod
```

**3. Read the posture.** `orangerail status` is the one screen that answers "is this
actually protecting me" — how many actions are gated, what is waiting on a human, and
whether the audit chain still verifies.

```console
$ npx orangerail status
orangerail status
  objects:  2
  actions:  6 approval-gated, 0 auto
  preset:   approval-for-writes
  pending:  0 approval(s) awaiting a decision
  server:   not detected — no orangerail mcp is running against this store
  audit:    chain OK — 0 record(s) verified
```

**4. Point your agent host at it.** Drop this in your project root as `.mcp.json`. The
lifecycle, the `claude mcp add` one-liner and the `--config` argument for hosts that start
elsewhere are all in [Wire it into your agent host](#wire-it-into-your-agent-host).

```json
{
  "mcpServers": {
    "orangerail": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orangerail", "mcp"],
      "env": { "DATABASE_URL": "file:./dev.db" }
    }
  }
}
```

**5. Ask the agent to destroy something.** Here a real host, wired exactly as above,
called the destructive tool. It came back holding an approval id instead of a deleted row:

```console
[agent]  deleteCustomer({ id: 2 })
         → {"status":"approval_pending","approvalId":"dff95d9d-8237-407a-b80b-c47252d56a1f"}
```

**6. You decide, in your own terminal.** The `server:` line reads a live heartbeat, and
the host's server had already exited by the time this ran — that is the stdio lifecycle,
not a fault.

```console
$ npx orangerail approvals list
dff95d9d-8237-407a-b80b-c47252d56a1f  "deleteCustomer"  by "local-dev" [dev]  5s ago  input={"id":2}

1 pending approval(s).

$ npx orangerail status
orangerail status
  objects:  2
  actions:  6 approval-gated, 0 auto
  preset:   approval-for-writes
  pending:  1 approval(s) awaiting a decision
  server:   not detected — no orangerail mcp is running against this store
  audit:    chain OK — 1 record(s) verified

$ npx orangerail approvals approve dff95d9d-8237-407a-b80b-c47252d56a1f
approve ok (approved)
```

The agent's next `check_approval` is the first moment the row can change. Nothing ran
before you said so, and every step is on the hash chain.

**7. Record the governance baseline — and commit it.** `ontology/` is yours to edit,
which means the one line that disarms this whole flow (`policy: { approval: 'required' }`)
is one careless deletion away, and a re-scan cannot notice: the scanner has no opinion on
policy. So the posture is compared against a file you record deliberately.

```bash
npx orangerail sync --accept-governance
```

That writes `orangerail.governance.json` at your repo root — one row per action holding
its approval gate, approver roles, `where` guard and target. **Commit it.** Its whole
value is that a pull request removing an approval gate shows `"approval": "required"`
turning into `null` in its own diff, in front of a human reviewer, before CI runs at all.
From then on `orangerail sync` fails (exit 1) when the posture *weakens* — a gate removed,
a `where` guard removed or rewritten, approver roles widened, an action retargeted, or a
new action that is not gated — and passes quietly when it tightens. `--accept-governance`
re-records the file, which is how you acknowledge a change you meant to make.

Two things to expect, both deliberate:

- **A project with at least one action and no baseline exits 1** until you have run
  `--accept-governance` once. Every existing project goes red exactly once, on purpose:
  the alternative is that deleting the file buys silence. A project with zero actions has
  no posture to vouch for and is never nagged.
- **A functional `where` predicate is opaque to the check.** It records as the constant
  `functional`, exactly as it does to the action signature hash, so rewriting the body of
  one is invisible here. Sync says so in its own output rather than implying coverage it
  does not have.

(`orangerail.governance.json` and `--accept-governance` are new since `0.1.0` — the
[CHANGELOG](./CHANGELOG.md) maps every user-visible change to its release.)

## See your whole domain as a map

`orangerail studio` reads your declared ontology and opens a live, read-only map of
your domain — every object, how they relate, and every write action an agent can
reach. Hover a table to light up its relations and actions; click one to see its
fields, links, and the **actions you can take on it** — each with the policy that
governs it (`deleteProduct` → approval required).

![the orangerail studio map — hovering tables to reveal relations, then focusing the actions an agent can take on a table](./assets/studio-map.gif)

> Crisper version: [`assets/studio-map.mp4`](./assets/studio-map.mp4). The map above is
> one real run of `orangerail studio` on a sample commerce domain — run it on your own
> project (or the [`governed-writes`](./examples/governed-writes) example) to explore
> yours.

## What orangerail will be

The domain rules you've been hand-writing into scattered markdown — product
statuses, order invariants, "never issue a coupon for a sold-out item" — declared
once in TypeScript (zod-native), and compiled into the three things an AI agent
working against your system actually needs:

- **A prompt rail** — generated domain docs for `AGENTS.md`, so agents are *guided*
  to behave well.
- **A runtime rail** — a typed MCP server with staged write-actions, human-in-the-loop
  approval, and a hash-chained audit log, so agents are physically *stopped* when
  they don't. What that log does and does not prove is stated exactly in
  [What the audit log proves](#what-the-audit-log-proves).
- **A map you can trust** — a live, read-only studio view of your objects, links,
  and actions, so you can *see* exactly what an agent can reach and confirm it
  matches your intent.

One declaration is the single source of truth for all three — they cannot drift
apart, because they are generated, not maintained by hand.

```ts
import { defineAction, defineObject } from 'orangerail-core';
import { z } from 'zod';

// Your existing backend. orangerail never replaces it — it only gates the call.
declare const findProduct: (id: string) => Promise<{ id: string; status: string } | null>;
declare const grantCoupon: (args: { productId: string; amount: number }) => Promise<void>;

// A `where` guard has to read the row it guards, so the target needs `resolve`.
export const Product = defineObject({
  name: 'Product',
  schema: z.object({ id: z.string(), status: z.string() }),
  resolve: { get: async ({ id }) => findProduct(id) },
});

export const issueCoupon = defineAction({
  name: 'issueCoupon',
  target: Product,
  input: z.object({ productId: z.string(), amount: z.number() }),
  policy: {
    approval: 'required',
    where: { field: 'status', op: 'neq', value: 'soldout' },
  },
  // `execute` runs only after the approval clears, and receives the validated
  // input plus the resolved caller. There is no `audit` switch: every staged,
  // approved, rejected and executed action is written to the hash chain.
  execute: async ({ input, identity }) => {
    await grantCoupon({ productId: input.productId, amount: input.amount });
    return { issuedBy: identity.subject };
  },
});
```

That block is not an illustration — it is
[`packages/cli/test/readme-example.ts`](./packages/cli/test/readme-example.ts) printed
verbatim, compiled by the repo typecheck and compared against this file on every run, so
it cannot rot into something that never compiled.

## v0 scope (in development)

- `orangerail init` — deterministic scanner (Prisma / OpenAPI) that extracts your
  ontology from code instead of asking you to type it. No LLM calls, no API keys —
  ever.
- `orangerail sync` — re-scan your sources and report drift, including a change in
  the governance posture itself. It compares the approval gates, approver roles,
  `where` guards and targets against `orangerail.governance.json` (a committed
  baseline you record with `orangerail sync --accept-governance`), so a removed
  approval gate fails the run instead of passing as "in sync". Exit 1 on drift.
- `orangerail mcp` — typed MCP server over your declared objects, links, and actions.
- `orangerail approvals` — CLI approval queue for staged actions.
- `orangerail audit verify` — hash-chain verification of the audit log, cross-checked
  against the approvals store. Read [What the audit log proves](#what-the-audit-log-proves)
  before you rely on it as a security control.
- `orangerail studio` — the live, read-only map of your domain graph.

Everything here runs from your repository alone — no external exports, no accounts,
no keys. Point it at your own code and it works.

## Wire it into your agent host

`orangerail mcp` is a **stdio** MCP server. There is no daemon and nothing to toggle:
the agent host spawns it as a child process, speaks JSON-RPC over its stdin/stdout, and
it dies when the host does. You never start it by hand — you tell the host how to start
it, and the host does the rest. (`orangerail status`, `approvals`, and `audit verify` are
ordinary commands you run in your own terminal, against the same store, while the host's
server is up.)

Nothing to install and nothing to build: the package is on npm, so the host can fetch and
run it on demand. For Claude Code, a `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "orangerail": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orangerail", "mcp"],
      "env": { "DATABASE_URL": "file:./dev.db" }
    }
  }
}
```

Or the equivalent one-liner, which writes exactly that file:

```bash
claude mcp add -s project orangerail -e DATABASE_URL="file:./dev.db" \
  -- npx -y orangerail mcp
```

`env` carries whatever your own `orangerail.config.mjs` needs to reach your backend — the
`DATABASE_URL` above is what the Prisma example uses. The server resolves the config from
the host's working directory; when that is not your project root, name it explicitly by
appending `"--config", "/abs/path/to/orangerail.config.mjs"` to `args`. Verify with
`claude mcp list`:

```console
$ claude mcp list
orangerail: npx -y orangerail mcp - ✔ Connected
```

A project-scoped `.mcp.json` is only connected to once you have trusted the directory in
the host; until then the same line reads `⏸ Pending approval`, which is the host asking,
not the config being wrong. As the server comes up it writes one line to stderr (stdout is
the JSON-RPC channel), which lands in your host's log:

```console
orangerail mcp: serving · governance active · 6 action(s) approval-gated · audit chain OK (0 record(s))
```

**From source instead.** If you are working on orangerail itself, or want to run an
unreleased change, point the host at your build rather than at npm. `dist/` is not
committed, so build first:

```bash
git clone https://github.com/KimHyeongRae0/orangerail.git
cd orangerail
pnpm install && pnpm -r run build     # produces packages/cli/dist/main.js
```

Then swap the server object's `command` and `args` for that file — everything else stays
the same:

```json
{
  "command": "node",
  "args": ["/abs/path/to/orangerail/packages/cli/dist/main.js", "mcp"]
}
```

### Also ask the host to prompt (optional, off by default)

An action you declared **without** `policy: { approval: 'required' }` has no orangerail
gate: calling its tool runs it. If your host has a permission prompt of its own, orangerail
can ask it to fire on every call to exactly those tools, by setting one field in
`orangerail.config.mjs`:

```js
export default {
  registry,
  store,
  // 'off' (default) | 'ungoverned-actions' | 'all-actions'
  hostApprovalPrompt: 'ungoverned-actions',
};
```

That adds `_meta: { "anthropic/requiresUserInteraction": true }` to those tools' entries in
`tools/list`. **Claude Code v2.1.199 and later is the only host known to honor it.** The
key is vendor-prefixed, which the MCP specification reserves for exactly this, so any other
host reads it as metadata it does not recognize and ignores it — there is no behavior change
anywhere else and nothing to disable.

`'all-actions'` extends it to your governed actions too. That is a second prompt in front of
a call that only *stages* an approval, so the write still cannot happen either way; what it
buys is that an agent cannot silently fill your approval queue. Most people should not want
it. Read tools and `check_approval` are never annotated under any setting: `check_approval`
is polled in a loop until a human decides, and a prompt on every poll is unusable.

Be deliberate about turning this on, because the flagged tool's prompt is not one the person
at the keyboard can dismiss. Per Claude Code's documentation it appears in every permission
mode including `bypassPermissions`, offers no "don't ask again", and is not skipped by an
allow rule; in `dontAsk` mode, which never prompts, the call is **denied** instead. A
headless pipeline that was working can stop working. That is why the default is `'off'`, and
why for a one-off you may prefer an ordinary `ask` rule in your host's own settings — that
one you can take back.

And to be exact about what this is: the annotation is enforced by the **client**. It is not
what makes orangerail's gate hold. A governed action stages and waits for a human no matter
which host is driving, whether that host prompts, and whether it honors this key at all. The
host prompt is a second checkpoint on top of the rail — never the rail.

## What orangerail does not govern

orangerail is a rail, and a rail only governs the traffic that runs on it. It sees exactly
one thing: calls made through its own MCP tools. Anything else the agent can reach is
invisible to it — a shell tool, a `psql` or `prisma studio` session, a second
database MCP server, your app's REST API, a background job someone else wrote. Nothing in
orangerail blocks those, stages them, or records them; they simply never happen as far as
the audit chain is concerned.

So the guarantee is a conditional one, and it is worth stating exactly: **when orangerail's
tools are the agent's only route to your domain, every write is staged, approved and
audited.** Closing off the other routes is your job, not the rail's.

## What the audit log proves

`orangerail audit verify` checks a lot. Every record's `hash` must recompute over its own
content and every `prevHash` must link to the record before it, so an edited or reordered
record breaks the walk. The chain is measured against a checkpoint persisted outside it
(`audit.head.json`), so a tail lopped off `audit.jsonl` alone is caught. Every started
execution must have a terminal record. And the audit chain and the approvals store are
cross-checked against each other wherever they overlap — staging, decision, decider,
requester, action, consumption, and the approved payload itself — so neither log is
trusted on its own and forging one of them is not enough.

That is a real bar. It is not the bar the phrase "tamper-evident" implies, so this project
does not use it. Stated exactly:

> An attacker with write access to the store directory can still delete audit records,
> re-chain the survivors with the public `hashAuditRecord`, re-anchor the unsigned
> `audit.head.json` that sits beside them, and edit `approvals.jsonl` to match — and
> `orangerail audit verify` will report the result as OK; what this release adds is that
> tampering with only *one* of the two logs, or with either one carelessly, is now
> detected.

The chain hash is unkeyed, `hashAuditRecord` is exported from `orangerail-core`, and the
anchor is an unsigned JSON file in the same directory as the records it anchors. So what
orangerail gives you today is **a human checkpoint and an audit trail** — a gated write
cannot execute without a person deciding, and every staged, approved, rejected and
executed action is on the chain — and not a tamper-evident boundary against someone who
owns the disk.

### Keep the store out of the agent's reach

All of that turns on who can write the store directory, and the default is the wrong
answer for a governed agent. `orangerail init` scaffolds the store **inside the project it
just scanned** — the generated `orangerail.config.mjs` builds it as:

```js
const store = createFileStore({ dir: join(here, '.orangerail', 'store') });
```

That is convenient for a local single-user run, and it is the worst available choice the
moment the governed agent also has file tools over that repo: the agent has write access
to the very log that records what it did, which is precisely the attacker in the paragraph
above.

There is no CLI flag for this, and no other mechanism: the store location is the `dir`
argument of `createFileStore`, and `orangerail.config.mjs` is a user-owned file that `init`
refuses to regenerate. Relocating the store is therefore a one-line edit you make once:

```js
const store = createFileStore({ dir: '/var/lib/orangerail/store' });
```

A correct deployment points that path at a directory the agent's tools cannot reach —
outside the workspace, owned by the operator account, with the agent's process holding no
write permission on it. The orangerail MCP server writes it; the agent never does. Its only
route is the MCP tools, which stage, poll and read your domain, and never expose the store
directory. If the agent and the operator are the same OS user on the same machine, you have
a human checkpoint and an audit trail and no boundary — which is exactly what the section
above says you have.

## Examples

Runnable, end-to-end examples live in [`examples/`](./examples). Each runs orangerail
on a single concept and proves the behaviour with real output:

- [`governed-writes`](./examples/governed-writes) — a destructive write stays
  available to an agent but is staged for human approval instead of executing, on a
  verifiable audit chain. Resolves the read-only-vs-write dilemma.

## Development

This repo is built under a deterministic 9-stage gate harness. Every change runs
through [`./scripts/verify.sh`](./scripts/verify.sh) — language, structure, gate
self-test, no-LLM, templates, then typecheck / lint / test / build — and CI runs that
script and nothing else, so a green local run is a green build. Each gate is a readable
script in [`scripts/`](./scripts) with its rules in its own header comment; the layout it
enforces is the tree you see. A hard invariant: no LLM-inference SDK is ever bundled
([`./scripts/check-no-llm.sh`](./scripts/check-no-llm.sh)).

## License

[MIT](./LICENSE)
