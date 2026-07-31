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
