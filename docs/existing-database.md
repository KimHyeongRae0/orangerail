# Adopting orangerail against an existing database

`orangerail init` reads files, not databases. It needs a `prisma/schema.prisma`
(or an `openapi.json`) to scan, and it refuses when it finds neither:

```console
$ npx orangerail init
orangerail init: no Prisma schema or OpenAPI JSON found in this repo.
Add a `prisma/schema.prisma` and/or an `openapi.json`, then re-run.
Already have a live database and no schema file? `prisma db pull` writes one — see docs/existing-database.md.
$ echo $?
1
```

If you already have a database and no schema file — the usual situation for
anyone adopting a governance tool onto something real — `prisma db pull`
(introspection) writes the schema for you. This page is that path, start to
finish.

**Everything below was run against PostgreSQL 16.14** with two tables
(`Article`, `Comment`) and no schema file, on both Prisma majors. The console
blocks are transcripts, not sketches.

Which major you are on changes three things, so pick your section:

| | Prisma 6 | Prisma 7 (what `npm install prisma` gives you today) |
| --- | --- | --- |
| Connection URL for the CLI | `url = env("DATABASE_URL")` in `schema.prisma` | `datasource.url` in `prisma.config.ts` |
| `.env` loading | automatic | you load it (`import 'dotenv/config'`) |
| Client construction | `new PrismaClient()` | `new PrismaClient({ adapter })` — a driver adapter is required |

orangerail detects which major your repo resolves and emits the matching
construction. You do not configure this; you only have to have the right
packages installed, which is what the two sections below make sure of.

## Prisma 6

**1. Install Prisma and point it at your database.**

```bash
npm install prisma@6 @prisma/client@6
```

`prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

`.env`:

```bash
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DBNAME"
```

**2. Introspect.** `db pull` reads the live schema and writes the models into
`schema.prisma`. It never modifies the database.

```console
$ npx prisma db pull
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "orangerail_test", schema "public" at "127.0.0.1:55432"

- Introspecting based on datasource defined in prisma/schema.prisma
✔ Introspected 2 models and wrote them into prisma/schema.prisma in 44ms

Run prisma generate to generate Prisma Client.
```

**3. Generate the client**, so the ontology has something to call.

```bash
npx prisma generate
```

**4. Scan.**

```console
$ npx orangerail init --yes --preset approval-for-writes --no-studio
  ✓  scanned your sources — 2 object(s), 6 action(s)
  ✓  generated a governed MCP server under ontology/
  ✓  --gate delete: 2 of 6 write action(s) gated behind human approval — the other 4 run when the agent calls them
```

Go on to [After init](#after-init).

## Prisma 7

Prisma 7 made two changes that both bite on this path.

**A datasource block carrying `url` is rejected.** Keep the Prisma 6 schema and
every `prisma` command fails before it starts:

```console
$ npx prisma db pull
Error: Prisma schema validation - (get-config wasm)
Error code: P1012
error: The datasource property `url` is no longer supported in schema files. Move connection URLs for Migrate to `prisma.config.ts` and pass either `adapter` for a direct database connection or `accelerateUrl` for Accelerate to the `PrismaClient` constructor.
```

**The client constructor requires a driver adapter.** `new PrismaClient()`
throws `PrismaClientInitializationError` — "A driver adapter is required to
connect to your database" — so generated code that does not pass one cannot run
at all.

**1. Install Prisma, the adapter for your database, and dotenv.**

```bash
npm install prisma @prisma/client @prisma/adapter-pg dotenv
```

The adapter package depends on which database you are on:

| datasource provider | adapter package | verified here |
| --- | --- | --- |
| `postgresql` | `@prisma/adapter-pg` | run end to end against PostgreSQL 16.14 |
| `sqlite` | `@prisma/adapter-better-sqlite3` | constructed against 7.9.1 |
| `mysql` | `@prisma/adapter-mariadb` | run end to end against MySQL 9.7.1 |
| `sqlserver` | `@prisma/adapter-mssql` | constructor signature only |

orangerail emits a client construction only for the adapters in that table.
With Prisma 7 and none of them installed, `init` refuses rather than generating
an ontology that cannot construct a client:

```console
$ npx orangerail init --yes
orangerail init: this repo is on Prisma 7+ (@prisma/client 7.9.1 (installed)) and no supported driver adapter is installed.
Prisma 7 removed the no-argument client constructor — generated code must pass a driver
adapter, and orangerail will not write an ontology that cannot construct a client.

Your datasource provider is `postgresql`, so install:
  npm install @prisma/adapter-pg

Then re-run `orangerail init`.
Staying on Prisma 6 also works: `npm install prisma@6 @prisma/client@6`.
$ echo $?
1
```

Nothing is written on that path — no config, no `ontology/`.

**2. Write the schema without a `url`.**

`prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}
```

Either client generator works, and they generate to different places — which is
why orangerail reads the block rather than assuming:

| `generator client` | generates to | the ontology imports |
| --- | --- | --- |
| `provider = "prisma-client-js"` | `node_modules/@prisma/client` | `@prisma/client` |
| `provider = "prisma-client"` + `output` | the `output` directory | that directory's `client.ts` |

`prisma-client` is what `npx prisma init` writes on Prisma 7, and it puts
**nothing** into `@prisma/client` — so an ontology that imported the package
would resolve a package with no client in it. It also needs an `output`: Prisma's
default differs by generator and version, and orangerail refuses rather than
guess a path whose only symptom would be the same failure somewhere else.

That generator emits TypeScript and nothing else (`generatedFileExtension`
accepts `ts`, `mts` and `cts`), so whatever runs `orangerail mcp` has to run a
`.ts` module. Node 22.18 and newer do that with no flag. On `prisma-client-js`
the generated client is JavaScript and no Node version matters.

**3. Put the URL in `prisma.config.ts`.** Prisma 7 no longer loads `.env` for
you, so load it yourself — otherwise *every* `prisma` command, `generate`
included, dies with `PrismaConfigEnvError: Cannot resolve environment variable:
DATABASE_URL`.

`prisma.config.ts`:

```ts
import 'dotenv/config';

import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
```

`.env`:

```bash
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DBNAME"
```

**4. Introspect and generate.**

```console
$ npx prisma db pull
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "orangerail_test", schema "public" at "127.0.0.1:55432"

- Introspecting based on datasource defined in prisma/schema.prisma
✔ Introspected 2 models and wrote them into prisma/schema.prisma in 423ms

Run prisma generate to generate Prisma Client.

$ npx prisma generate
✔ Generated Prisma Client (v7.9.1) to ./node_modules/@prisma/client in 43ms
```

**5. Scan.**

```console
$ npx orangerail init --yes --preset approval-for-writes --no-studio
  ✓  scanned your sources — 2 object(s), 6 action(s)
  ✓  generated a governed MCP server under ontology/
  ✓  --gate delete: 2 of 6 write action(s) gated behind human approval — the other 4 run when the agent calls them
```

The generated files now build the client through the adapter:

```js
const getPrisma = (() => {
  let client;
  return async () => {
    if (client === undefined) {
      const url = process.env.DATABASE_URL;
      if (url === undefined || url === '') {
        throw new Error("orangerail: DATABASE_URL is not set. …");
      }
      const { PrismaClient } = await import('@prisma/client');
      const { PrismaPg } = await import("@prisma/adapter-pg");
      client = new PrismaClient({ adapter: new PrismaPg(url) });
    }
    return client;
  };
})();
```

`DATABASE_URL` is the variable name your schema declared (`url = env("…")`) or,
when the schema declares none — which is the Prisma 7 default — `DATABASE_URL`.
These files are yours: if your setup needs pooling options, a different variable,
or an adapter orangerail does not emit, edit the construction and `orangerail
sync` will not touch it.

## After init

**1. Install the runtime the generated code loads.**

```bash
npm install orangerail-core zod
```

**2. Check the posture.**

```bash
npx orangerail status
```

**3. Give the server the connection URL.** The generated ontology reads
`DATABASE_URL` from its own process environment, so whatever starts the MCP
server has to carry it — `.mcp.json` is the usual place:

```json
{
  "mcpServers": {
    "orangerail": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "orangerail", "mcp"],
      "env": { "DATABASE_URL": "postgresql://USER:PASSWORD@HOST:5432/DBNAME" }
    }
  }
}
```

The rest — wiring an agent host, the approval flow, the audit chain — is in the
[README](../README.md).

## When the schema changes

`db pull` again, then `orangerail sync`. Introspection rewrites
`prisma/schema.prisma`; `sync` re-scans it and *reports* what drifted against
your registry. It never rewrites the files under `ontology/` — those are yours.

## Troubleshooting

**`P1012 … datasource property 'url' is no longer supported`** — you are on
Prisma 7 with a Prisma 6 schema. Move the URL to `prisma.config.ts` (step 3
above).

**`PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`** —
Prisma 7 does not load `.env`. Add `import 'dotenv/config';` at the top of
`prisma.config.ts`, or export the variable in your shell.

**`PrismaClientInitializationError: PrismaClient was instantiated without any
options. A driver adapter is required`** — the ontology was generated while the
repo resolved Prisma 6 and is now running against Prisma 7. Install the adapter
for your provider, delete the generated `ontology/` and `orangerail.config.mjs`,
and re-run `init`.

**`orangerail: DATABASE_URL is not set`** — the generated code found no
connection URL in its environment. That is the message from the generated file
itself, before any driver is touched; set the variable in whatever starts the
server.

**`your Prisma schema declares generator client { provider = "prisma-client" }
with no output`** — that generator writes the client into the directory `output`
names, so there is no directory for the ontology to import. Add the `output` the
refusal quotes (it is the one `prisma init` writes), or switch to
`prisma-client-js`. Nothing is written on that path.

**`Cannot load the generated Prisma client … this Node build does not run a .ts
module`** — the client is generated, at the right path, and this Node will not
load TypeScript. Run the MCP server on Node 22.18 or newer, or set
`provider = "prisma-client"` back to `provider = "prisma-client-js"` and re-run
`prisma generate`. Re-running `generate` on its own cannot fix this, which is why
the message does not ask you to.

**`Cannot resolve @prisma/client for object "X"`** — the client is not
generated. Run `npx prisma generate`. On Prisma 7 the same diagnostic reads
`Cannot resolve @prisma/client or @prisma/adapter-pg`, because either import can
be the missing one; its fix names both packages.
