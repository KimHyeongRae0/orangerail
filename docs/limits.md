# What orangerail does not govern

orangerail is a rail, and a rail only governs the traffic that runs on it. It sees exactly
one thing: calls made through its own MCP tools. Anything else the agent can reach is
invisible to it — a shell tool, a `psql` or `prisma studio` session, a second database MCP
server, your app's REST API, a background job someone else wrote. Nothing in orangerail
blocks those, stages them, or records them; they simply never happen as far as the audit
chain is concerned.

So the guarantee is a conditional one, and it is worth stating exactly: **when orangerail's
tools are the agent's only route to your domain, every write runs under the policy that write
declares, and every write lands on the audit chain — a gated one only after a human approved
it.** Note what that does and does not promise. It is not "every write is staged": since
`--gate delete` became the default, an un-gated `create` or `update` executes on the agent's
word, and it does so *by your configuration*, which the rail honors. What survives
unconditionally is the audit record. Closing off the other routes is your job, not the rail's.

This is not a theoretical caveat. In a validation run against live PostgreSQL, with
orangerail installed and every write action gated, a second Postgres MCP server was added on
the same database and the agent deleted five rows through it with zero approvals and nothing
on the audit chain. The gate held on its own tools and was simply not on the path. Treat "the
agent has exactly one route to this database" as a precondition of installing orangerail, not
as advice.

**`orangerail status` now tells you when that precondition does not hold — as far as it can
see.** It reads the project's own MCP client config (`.mcp.json`, `.cursor/mcp.json`,
`.vscode/mcp.json`), and any server declared there that is not this project's `orangerail
mcp` is named on the readout under `hosts:`, as is the `init` closing summary the moment you
generate a narrow surface next to a wide one. It reports server names only — never a
command, an argument or an environment value, because a database server's arguments routinely
carry a connection string. It exits **0** either way: mounting a Slack server next to
orangerail is an ordinary, deliberate choice, and the honest claim is the narrow one — those
tools are outside this project's governance, not that they are unsafe. And it is a floor
rather than an inventory: **project-scope config only**. User- and machine-scope config
(`~/.claude.json`, Claude Desktop's, `~/.cursor/mcp.json`) is deliberately not read, so a
clean `hosts:` line means "nothing in this repo declares another server", never "nothing else
is mounted". orangerail does not block, proxy or govern whatever it finds — it makes the fact
visible, which is the part that was missing.

## There is no aggregation, no join, and list results are capped

The generated read tools are exactly two shapes: a `findUnique` by id, and a `findMany` with
your filter, ordered by id, returning 50 rows by default and 200 at most, with a cursor to
page. There is no `groupBy`, no `_sum`, no `_count` and no join anywhere in the generated
code, so "what did we bill this customer last quarter" is not a question this surface can
answer — the agent must page the rows and do the arithmetic itself, or the question goes
somewhere else entirely.

One consequence is worth naming, because it is easy to mistake for a feature. An aggregate
spanning two one-to-many relations off the same parent — the classic *fan trap*, where the
number comes back silently multiplied and no error is raised — cannot be asked through
orangerail. That is the absence of a capability, not a guard against a mistake. The read
tools do state each object's cardinalities in their descriptions, and that changes nothing
here: there is no aggregate to get wrong, so there is nothing for the cardinality to protect.
If the agent has any other route to SQL, it can still write that query, and orangerail will
neither see it nor say anything about it.

## There is no DDL

From a Prisma schema the scanner emits row-level writes only — create, update and delete per
model, one row at a time, and create alone for a model with no single `@id` — and nothing at
all for schema change. `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE` and every migration have
no generated action, so they go around orangerail entirely and are neither gated nor audited.
Keep migrations where they already are: in your migration tool, reviewed in a pull request,
run by CI or by a person — not by the agent. If the agent needs to propose one, have it write
the migration file and let the normal review path decide, because that path is a human
checkpoint orangerail is not offering here.

## A table Prisma cannot model gets no tool, and that is not protection

Some tables never reach the generated surface at all. `prisma db pull` attaches `@@ignore` on
its own to any table without a unique identifier — partitioned tables, join tables, event
tables — and Prisma Client generates no delegate for those, so orangerail generates no action
for them either. `orangerail init` names them:

```console
$ orangerail init
orangerail init: prisma: skipping 2 model(s) carrying `@@ignore` (events, no_pk_table) —
Prisma Client generates no delegate for them, so no tool can be generated
```

**Read that as absence, not as a boundary.** Those tables are not read-only, not gated, and not
audited. They are simply not on the map, and every credential that reaches the database still
reaches them — the same second-route problem as above, arriving through the on-ramp this project
recommends rather than through a tool the agent was handed. If one of those tables matters, the
answer is a unique identifier in the schema, not the silence.

Before ONT-113 this was worse than silence: the ignored models became tools that called an
undefined delegate, so `tools/list` advertised writes that threw when an agent called them.

## A bulk intent costs one approval per row

"Delete the 40 stale drafts" is 40 calls to `deleteArticle`, 40 staged approvals, and 40
decisions — the generated actions take a single id, `orangerail approvals approve` takes a
single id, and there is no batch action and no approve-all. That is honest about the
ergonomics today rather than a design position. Where a bulk operation is a real part of your
workflow, the way out is to hand-write one `defineAction` whose `execute` performs the whole
batch, so a single approval covers a single reviewed intent — the generated per-row actions
are a starting point, and `ontology/` is yours to edit.

## A `BigInt` is a string on the wire, and the unsigned range does not fit

A `BigInt` column travels through orangerail as a **decimal string** — in the published
schema, in an action's input, in a resolver's output, in a cursor, in a filter operand, and in
the audit record. That is not a stylistic choice. JSON has no integer type wide enough for a
64-bit key, and `JSON.parse` rounds one above 2^53: an id of `9007199254740993` sent as a JSON
number arrives as `9007199254740992` and the call quietly targets a different row. So
`tools/list` publishes such a field as `{"type":"string"}` with a `^-?\d+$` pattern, and a
number is refused rather than narrowed.

Two consequences to plan around.

**The filter has no `contains`.** Prisma's `BigIntFilter` has ordering and equality and
nothing else, so a `BigInt` column publishes `equals`, `gt`, `gte`, `in`, `lt`, `lte` and
`not` over string operands, and `contains` / `startsWith` / `endsWith` are refused by the
server. Prefix-matching an id was never a query the datasource could answer; the refusal now
arrives with the field named instead of as an opaque datasource error.

**A `BIGINT UNSIGNED` key above 2^63-1 can be read but not targeted.** MySQL's unsigned range
runs to 2^64-1 and Prisma's `BigInt` scalar is signed 64-bit. Such a row comes back from
`_list` with every digit intact, and passing its id to `_get`, `update` or `delete` is refused
by Prisma before a query is built (`number too large to fit in target type`) — which reaches
the agent as a correlated `resolve_error`. In practice an `AUTO_INCREMENT` key reaches 2^63
only if it was seeded there; if yours was, that boundary is the datasource client's and not
something this transport can widen.

## Typed is not enforced — where the check actually lives

The read `filter` published to the agent is enforced by the **server**, and orangerail earned
the right to say "enforced" the hard way.

In `0.1.0` that filter was advertised to the agent as `{ "type": "object" }` and handed to the
object's resolver untouched — which for a generated Prisma resolver is
`findMany({ where: filter })`, meaning Prisma's entire `where` grammar, relation predicates
included. Against a project generated with `--models Customer`, where `ontology/` held no
`Order` file and `tools/list` carried no `Order` tool at all, calling `Customer_list` with
`{ "orders": { "some": { "secret": { "startsWith": "h" } } } }` returned the customers whose
unexposed order secret began with `h`, while the same probe with `"q"` returned none. That
difference is a boolean oracle: walked over a 36-symbol alphabet it read a seven-character
column of a table the server never exposed, in 151 `Customer_list` calls and no other tool.
The full account is in the [CHANGELOG](../CHANGELOG.md) under Security.

The lesson is the concept and not the bug. A schema the agent is shown and the server does not
check is documentation, and an agent is under no obligation to read your documentation. So the
filter is now validated against the object's own declared fields before it reaches any
resolver, and that exact probe is a regression test
([`packages/mcp/test/read-surface.test.ts`](../packages/mcp/test/read-surface.test.ts)) which
asserts the call now comes back
`Filter rejected: "orders" is not a filterable field of this object (fields: email, id, name).`

**Be exact about where that check lives, because it is not where you would guess.** It is in
`orangerail-mcp`'s list handler
([`packages/mcp/src/server.ts`](../packages/mcp/src/server.ts), `handleList`) — **not** in
codegen. The generated resolver still builds `findMany({ where: filter })` out of whatever it
is handed
([`packages/cli/src/commands/init/codegen/emit-object.ts:300`](../packages/cli/src/commands/init/codegen/emit-object.ts)),
so anything that imports `ontology/*.mjs` and calls `resolve.list` itself — your own script, a
second server, a test — gets the unbounded `where` back. The placement is deliberate: on the
server the check covers hand-written resolvers identically, and upgrading the package fixes an
existing project with no re-run of `init`. But it makes the honest sentence a two-part one:
`ontology/` is what you **review**, and `orangerail mcp` is what **enforces**. The ontology
files are the declaration, not the boundary.

## A `where` clause checks the field it reads, and a functional one checks nothing

A **declarative** `where` — `{ field, op, value }` — now parses the target row against the
object's declared schema and refuses when the field it is about to read is not what the object
says it is. That is a real gate: before it, a row missing the field yielded `undefined`, and
`undefined !== 'soldout'` is `true`, so a clause written to stop an action permitted it. The
refusal is its own outcome, `target_nonconforming`, distinct from `rejected_where`.

Three things it deliberately does not do, each of which you should know before relying on it.

**It checks one field.** The clause consults one field, so one field is checked. A row that
fails its schema in a column no policy reads passes exactly as it did before — that is what
keeps this a bugfix rather than a rule that rejects working projects — and it means the gate is
not a row validator and must not be read as one.

**It cannot check a functional predicate at all.** A `where` written as a function receives the
row verbatim ([`packages/core/src/policy/where.ts`](../packages/core/src/policy/where.ts)) and
the engine has no way to know which fields it reads. Nothing about it is checked, and a
predicate that derefs a field the row does not carry behaves exactly as it always has. If you
want the check, write the clause declaratively.

**It is only as precise as your declaration.** The verdict comes from the zod schema in
`ontology/*.mjs`. A field declared `.optional()` is conforming when absent, and a field
declared `z.unknown()` admits everything — which is what the scanner emits for a `Json` column
([`packages/cli/src/commands/init/codegen/zod.ts`](../packages/cli/src/commands/init/codegen/zod.ts)).
A generated ontology's declaration is a scan of your schema at one moment; `orangerail sync` is
what tells you the two have parted company.

## What the governance baseline defends against

`orangerail.governance.json` catches *unnoticed* change — a bad merge, a careless refactor, or
the governed agent itself editing the repo it has file tools over. It is not a defense against
someone with write access to your repo who means it; they can edit `orangerail.config.mjs` and
own everything regardless.

**What "refuses to serve" means, exactly.** It is not only a `sync` warning. With a gate removed
from an action, a freshly started server prints `GOVERNANCE DRIFT … WITHHOLDING <action>`, the
action is absent from `tools/list`, and calling it by name returns `{"status":"unknown_tool"}`.
`sync` and `status` both exit 1. Everything else is served normally.

**And what it does not reach.** The gate resolves against the approvals store, not the audit
chain. Anything that can write that directory can append one well-formed `resolved` event and
the next `check_approval` executes the staged action with no human decision — `audit verify`
reports it afterwards (`no "approved" audit record`), but the write has already happened. The
default scaffold puts that store **inside the project the agent has file tools over**, which is
why [Keep the store out of the agent's reach](./audit-log.md#keep-the-store-out-of-the-agents-reach)
is not optional advice. Drift detection protects the *declaration*; it does not protect the
store.

Three behaviours to expect, all deliberate:

- **A project with at least one action and no baseline at all exits 1** from `sync` until you
  have run `--accept-governance` once. Projects created before this existed go red exactly
  once, on purpose: the alternative is that deleting the file buys silence. A project with
  zero actions has no posture to vouch for and is never nagged. The *server* still starts in
  that state — locking you out of a project that predates the file would be punishment, not
  protection.
- **A missing or unreadable baseline never stops the server.** Deleting the file is always an
  available downgrade, so failing closed on a corrupt one would buy no safety and cost you
  your server over a JSON typo. Both states are reported loudly and neither reads as verified.
- **A functional `where` predicate is opaque to the check.** It records as the constant
  `functional`, exactly as it does to the action signature hash, so rewriting the body of one
  is invisible here. Sync says so in its own output rather than implying coverage it does not
  have.

The baseline also compares against the *starting point*, so an action generated un-gated is
recorded un-gated and never trips the weakening check. It catches a later edit, not a
permissive `--gate`.
