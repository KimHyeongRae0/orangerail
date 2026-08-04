# The MCP registry entry

orangerail is listed on the official MCP registry at `registry.modelcontextprotocol.io` as
**`io.github.KimHyeongRae0/orangerail`**. This page is what that listing is, what it is not, and the
one thing it cannot tell you in the space it has.

## What the registry stores

Metadata, and nothing else. The package still comes from npm; the registry holds the name, the
description, the repository, and how to run it. `server.json` at the root of this repository is that
metadata, and it is the file that gets published.

The registry verifies two things before it stores anything:

- **The namespace.** `io.github.KimHyeongRae0/` is provable only by the GitHub account of that name.
- **The package.** `packages/cli/package.json` carries `mcpName`, and the registry reads it out of
  the tarball actually on npm. That is why it could not be added retroactively — npm versions are
  immutable, so it had to ship in a release (`0.1.4`).

## The thing 100 characters cannot say

The registry caps a description at 100 characters. Ours spends them on this:

> Turns your Prisma schema into typed MCP tools, with destructive writes gated behind human approval

What it leaves out is the step before: **`orangerail mcp` serves the ontology that `orangerail init`
generated in your repository.** With no `ontology/` directory there is nothing to serve. Most
listings you have installed are `npx -y <thing>` and they work immediately; this one scans your
schema first, and that scan is the product.

If you arrived here from the registry, [the Quickstart](../README.md#quickstart) is the seven steps,
and step 2 is the one that generates the surface.

## Why the entry does not say `npx`

A client generating a config from this entry gets the binary and the `mcp` argument, not an
`npx -y orangerail`. That is deliberate: fetching a second copy through `npx` puts two
`orangerail-core` instances in the process, and every `orangerail status` after it opens with a
`runtime:` block reporting them — see
[two copies of `orangerail-core`](./troubleshooting.md#two-copies-of-orangerail-core). Writes still
complete under it, so it is a hazard rather than a fault, and it is avoidable. An entry that led
readers into the path this project's own troubleshooting page tells them to avoid would not be worth
having.

## The version is pinned, and that is checked

`server.json` names a version twice, and both go stale the moment a release moves without it.
Nothing in this repository reads the file at runtime, so a stale one would fail silently — the
registry would keep advertising the previous release while npm moved on.

`.github/workflows/release.yml` therefore checks, in the same step that checks the five package
versions agree, that `server.json` declares the version being released and that its `name` still
matches `packages/cli`'s `mcpName`. The release that would strand the entry is the release that
fails.

## Publishing it

Publishing is the repository owner's action, not something CI does and not something an agent in
this repository does. It is two commands with the
[`mcp-publisher`](https://github.com/modelcontextprotocol/registry) CLI:

```bash
mcp-publisher login github    # a GitHub device flow — authenticates a person
mcp-publisher publish         # reads ./server.json
```

The login returns a credential tied to an individual account. That is the reason this one stays
manual.

The registry is in preview and says so: breaking changes and data resets may happen before general
availability. `server.json` living in the repository is what makes re-publishing cheap when they do.
