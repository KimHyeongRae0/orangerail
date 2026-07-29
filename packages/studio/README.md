# orangerail-studio

The **map you can trust** of
[orangerail](https://github.com/KimHyeongRae0/orangerail): a local, read-only web
app that renders your declared ontology as an interactive domain map — every
object, how they relate, and every write action an agent can reach, each with the
policy that governs it.

The point is not decoration. If you are going to hand an agent tools over your
domain, you should be able to *see* exactly what it can reach and confirm it
matches your intent, without reading generated code.

Most users never install this directly — the `orangerail` CLI depends on it and
serves it:

```bash
npx orangerail studio
```

It opens at `http://127.0.0.1:4820` by default (`--port <n>`, `--no-open`), reads
your config, and pushes a fresh snapshot over SSE as you edit your ontology.
Nothing leaves your machine: there is no account, no telemetry and no external
asset — fonts are bundled locally.

## Install

```bash
npm install orangerail-studio
```

`orangerail-core` is a dependency; `zod` is a peer dependency (`^3.23 || ^4`).
React, React Flow and ELK are dev-only — they are bundled into the prebuilt app,
not imposed on your project.

## What the package ships

Two build outputs in one tarball:

- **`dist/app`** — the prebuilt browser app, all asset URLs relative, so any
  static file server can mount the directory at `/`. Nothing to build.
- **`dist/node`** — a node-consumable entry with no browser dependencies, which
  is what the `.` and `./snapshot` exports resolve to.

```ts
import { buildSnapshot, studioAppDir } from 'orangerail-studio/snapshot';

const snapshot = buildSnapshot({ registry }); // { objects, links, actions }
const appDir = studioAppDir(); // absolute path of the prebuilt app to serve
```

`buildSnapshot` is pure and does no I/O. Objects, links and actions come out
alphabetically ordered, so the same registry always produces the same snapshot.

Also exported: `buildInstanceSnapshot` (the runtime instance graph view) and
`buildAgentFleetSnapshot` with its derivations — `deriveUngatedDestructiveActions`,
`deriveBlastRadius`, `deriveAuthorityOverlaps`, `deriveDelegationCycles`,
`deriveRecursiveSpawners`, `deriveObjectWriters` — which back the agent-fleet
governance view.

## Governance facts are truthful

A snapshot action carries `approval: 'auto' | 'required'`, its approver `roles`,
and `where: 'none' | 'declarative' | 'functional'`. A **functional** guard is
marked `functional` and is never pretended declarative — only a declarative guard
gets `whereText` — so the map never draws a condition it cannot actually read.
`notImplemented` stubs are carried through rather than rendered as working
actions.

## Read-only, by construction

The studio renders a snapshot. It has no approve button and no route to your
datasource; the approval decision lives in `orangerail approvals` in your own
terminal, on purpose. The server the CLI runs answers `GET`/`HEAD` only — every
other method is a `405` — and serves exactly two endpoints beside the static app:
`GET /api/registry` for the snapshot JSON and `GET /api/events` for the reload
stream. All strings pass through the snapshot layer verbatim and the frontend
renders them as text nodes only, so a hostile name in your schema cannot become
markup.

## License

[MIT](https://github.com/KimHyeongRae0/orangerail/blob/main/LICENSE)
