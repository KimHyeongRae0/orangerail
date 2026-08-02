# How orangerail compares

Deterministic codegen from a spec into MCP tools is not new, and neither is a database MCP
server. What is specific here is the pair: typed per-entity tools generated from your schema
instead of a generic query tool — including the read `filter`, which is a closed set of
predicates over declared fields that the server enforces, rather than a `where` clause the
agent composes — and a per-action approval gate with a recorded baseline that `sync` and `mcp`
both enforce.

Each claim below was checked against the shipped package or the vendor's own documentation on
2026-07-29, and the `--read-only` reading was re-checked against source on 2026-07-30.

## What the agent can reach, three ways

|  | what the agent can do |
| --- | --- |
| `execute_sql` on a general-purpose database MCP server | anything the connection can |
| the same server started with `--read-only` | read anything in the database |
| orangerail | exactly the calls you declared, argument shapes included |

The middle row is narrower than it sounds, because `--read-only` constrains the verb and not
the reach. On Supabase's server the flag leaves `execute_sql` on the tool list still taking the
same single `query: z.string()` parameter and passes `read_only: true` down with it — the tool
is declared `readOnlyBehavior: 'adapt'`, which that repo defines as "stays available in
read-only mode, adapts behavior". Meanwhile `apply_migration` declares no such behavior (the
documented default is `'exclude'`, "removed from tool list") and its handler throws
`Cannot apply migration in read-only mode.` if it is reached anyway
([`tools/database-operation-tools.ts`](https://github.com/supabase/mcp/blob/main/packages/mcp-server-supabase/src/tools/database-operation-tools.ts)
and [`tools/util.ts`](https://github.com/supabase/mcp/blob/main/packages/mcp-server-supabase/src/tools/util.ts)
on `main`, read 2026-07-30). That is a real distinction and a useful one. It is not an answer
to "what can this agent see": every table, every column and every row is still one string away.

## A markdown rules file

The honest comparison, and the one most readers should run before installing anything. It has a
page of its own: [against the thing you would do instead](./vs-a-rules-file.md) — three clean
runs, two adversarial ones, one on a smaller model, the axis where the rules file beats
orangerail, and the one row that does not tie.

## `openapi-mcp-generator`

[`openapi-mcp-generator`](https://github.com/harsha-iiiv/openapi-mcp-generator) (627 stars;
16,389 npm downloads in the week ending 2026-07-28) is real prior art on the OpenAPI half, and
good at it. Its `extractToolsFromApi` walks paths × methods and emits exactly one tool per
operation — deterministic, zod-validated, no LLM anywhere in it, with content-hash name
de-collision so a reordered spec produces the same output.

What it does not have is any approval policy: an operation that deletes becomes a tool that
deletes, and it runs when the agent calls it. That is the substance of the difference, and it
is about the write path; on relations orangerail is ahead by one clause of prose per read tool,
which is worth about what that sounds like — an OpenAPI spec has no relation graph to derive
one from in the first place. If one tool per REST operation is all you want, it is more mature
at that than orangerail is.

## Prisma's own MCP servers

CLI and platform operations, not per-model tools. The local server in `prisma@7.9.1`
(`npx prisma mcp`) registers three tools — `migrate-status`, `migrate-dev` and `Prisma-Studio`
— each shelling out to the Prisma CLI. The
[hosted server](https://www.prisma.io/docs/postgres/integrations/mcp-server) covers databases,
backups, recovery and connection strings, plus `ExecuteSqlQueryTool` and
`IntrospectSchemaTool`. Neither generates anything typed per model.

## Supabase's MCP server

[Supabase's MCP server](https://github.com/supabase/mcp) exposes `list_tables` and
`execute_sql`. Foreign keys are not missing — each table in a `list_tables` response can carry
a `foreign_key_constraints` array of constraint rows (name, source and target table, source and
target columns), but only when the call passes `verbose: true`; without it the handler returns
the compact table and drops them. That is an introspection payload for the agent to interpret,
not a declared relation carrying a cardinality; orangerail puts the cardinality on the surface,
in the read tool's own description (`Relations: has many Order.`).

Be clear about the size of that difference: it is one sentence per tool. It saves an agent a
`verbose: true` round trip and the work of turning constraint rows into a direction, and it
buys nothing else — orangerail cannot follow the relation either, and unlike `execute_sql` it
cannot express the join that would. Compared against Supabase the honest summary is a narrower
surface with a clearer label on it, not a more capable one.
