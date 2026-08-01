# What the audit log proves

`orangerail audit verify` checks a lot. Every record's `hash` must recompute over its own
content and every `prevHash` must link to the record before it, so an edited or reordered
record breaks the walk. The chain is measured against a checkpoint persisted outside it
(`audit.head.json`), so a tail lopped off `audit.jsonl` alone is caught. Every started
execution must have a terminal record. And the audit chain and the approvals store are
cross-checked against each other wherever they overlap — staging, decision, decider,
requester, action, consumption, and the approved payload itself — so neither log is trusted on
its own and forging one of them is not enough.

That is a real bar. It is not the bar the phrase "tamper-evident" implies, so this project
does not use it. Stated exactly:

> An attacker with write access to the store directory can still delete audit records,
> re-chain the survivors with the public `hashAuditRecord`, re-anchor the unsigned
> `audit.head.json` that sits beside them, and edit `approvals.jsonl` to match — and
> `orangerail audit verify` will report the result as OK; what this release adds is that
> tampering with only *one* of the two logs, or with either one carelessly, is now detected.

The chain hash is unkeyed, `hashAuditRecord` is exported from `orangerail-core`, and the
anchor is an unsigned JSON file in the same directory as the records it anchors. So what
orangerail gives you today is **a human checkpoint and an audit trail** — a gated write cannot
execute without a person deciding, and every staged, approved, rejected and executed action is
on the chain — and not a boundary against someone who owns the disk.

## What the chain does when it cannot describe something

A governed write can return a value JSON refuses to serialize: a row that points back at
itself, a driver id that comes back as a `BigInt`, an object whose `toJSON` throws. Until
`0.1.1` that value threw from inside the append, which meant the write had already landed in
your database and the chain said nothing about it — and the agent, told the call failed, would
try again.

Three rules now cover it, and they are worth knowing because two of them are visible in your
log:

**Rendering is total, and it states what it replaced.** A refused value is written with the
fields that could be persisted intact and a marker in place of the ones that could not:
`"self": "[unserializable: circular reference]"`, `"id": "[unserializable: bigint
9007199254740994]"`. It is not silently dropped and the append is never the thing that fails.
The same rendering feeds the hash, so the record verifies exactly as it was written.

**The record comes before the claim.** `execute` appends `execution_started` and only then
consumes the approval. If the append fails — an unwritable store, a full disk — the call
answers `audit_blocked`, nothing runs, and **the approval is still approved**: fix the store
and the same approval id completes. Under the old order it was already spent, so
`check_approval` answered "Already executed (consumed)." about an execution that never
happened, `approvals approve` refused it as `already_resolved`, and `audit verify` failed for
good. The consume is still a single-winner CAS, so two callers still cannot both execute; the
loser writes an `execution_aborted` record against the `execution_started` it had already
written, which is why a race does not read as a replayed approval.

**A terminal record that cannot be written is said out loud.** If the action ran and the store
refuses its `succeeded`/`failed` record, orangerail appends a `terminal_unrecorded` marker —
no input, no prior, no result, the smallest record that still names the execution — and
`audit verify` reports it:

```
terminal record could not be written for <id>: the action ran and the chain does not carry its outcome
```

which is a different sentence from the one for a process that died mid-execution:

```
incomplete execution for <id>: started but never finished — no terminal record was appended, so the process died mid-execution
```

Tell them apart, because they need different things from you: the first says a write landed and
you have to reconcile one row by hand, the second says you do not know whether it landed at all.
If even the marker cannot be appended, `execute` returns `audit_unrecorded` rather than
reporting a success nothing recorded — the write is done and must not be retried.

The agent calling through MCP is told exactly that, in a status of its own and a sentence that
carries both halves:

```
Executed, and NOT recorded. The action ran and its side effect has already landed — the write
is done — but the audit chain holds no terminal record of it, not even the minimal marker,
because the store refused every append. Do NOT retry this call and do NOT re-stage the action:
either one repeats a write that has already happened. […] correlationId "<id>".
```

Both halves are load-bearing. Reported as a success, the agent carries on believing the chain
knows about a write it does not; reported as an ordinary failure, the agent does the one thing
that must not happen and retries, and the write lands twice. The store error itself stays off
that path — it goes to the operator sink (stderr by default), keyed by the same correlationId,
which for this status is the only place it survives at all.

One window is left, and it is the mirror of the one this replaced: a process that dies between
`execution_started` and the consume CAS leaves a started record for an approval that never ran
and is still executable. Running it later leaves two started records for one approval, which
`audit verify` reports as a replay, naming both readings. Nothing is rewritten to hide it — the
chain is append-only, and a repair command that edited history would destroy the only property
it has.

## Where a database-level audit is the better tool

Be direct about the alternative, because for many teams it is the right one. Postgres triggers
or `pgaudit` record writes from *every* source — your app, a migration, a person with `psql`,
a second MCP server — and orangerail only ever sees its own tools. If the question you need
answered is "what changed in this table, by anyone", that is broader coverage than this chain
will ever have, and you should use it.

What the chain adds on top is narrower and specific: it is joined to the *decision*. A row in
`pgaudit` says a value changed. An orangerail record says which action staged it, which
identity requested it, which human approved it, what the row looked like immediately before
(`prior`), and that the approved payload is the one that executed. The two are complements,
and if you only get one, coverage usually beats provenance.

## Keep the store out of the agent's reach

All of the above turns on who can write the store directory, and the default is the wrong
answer for a governed agent. `orangerail init` scaffolds the store **inside the project it
just scanned** — the generated `orangerail.config.mjs` builds it as:

```js
const store = createFileStore({ dir: join(here, '.orangerail', 'store') });
```

That is convenient for a local single-user run, and it is the worst available choice the
moment the governed agent also has file tools over that repo: the agent has write access to
the very log that records what it did, which is precisely the attacker in the paragraph above.

There is no CLI flag for this, and no other mechanism: the store location is the `dir` argument
of `createFileStore`, and `orangerail.config.mjs` is a user-owned file that `init` refuses to
regenerate. Relocating the store is therefore a one-line edit you make once:

```js
const store = createFileStore({ dir: '/var/lib/orangerail/store' });
```

A correct deployment points that path at a directory the agent's tools cannot reach — outside
the workspace, owned by the operator account, with the agent's process holding no write
permission on it. The orangerail MCP server writes it; the agent never does. Its only route is
the MCP tools, which stage, poll and read your domain, and never expose the store directory. If
the agent and the operator are the same OS user on the same machine, you have a human
checkpoint and an audit trail and no boundary — which is exactly what the section above says
you have.
