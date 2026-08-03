# Troubleshooting

Readouts that report something wrong with the **install** rather than with your policy. Nothing
here is fixed by editing `ontology/` or `orangerail.governance.json`.

- [Two copies of `orangerail-core`](#two-copies-of-orangerail-core)
- [CORE VERSION SKEW](#core-version-skew)
- [When neither block appears](#when-neither-block-appears)

## Two copies of orangerail-core

`orangerail status` opens with a `runtime:` block, above the counts:

```console
$ npx -y orangerail@0.1.2 status
orangerail status
  runtime:  two copies of orangerail-core are loaded (one by this config, one by the CLI).
            They agree on the approval contract, so writes work — until a partial upgrade
            makes them disagree, at which point governed writes stop silently. Dedupe.
  objects:  2
$ echo $?
0
```

and `orangerail mcp` carries the same finding as a clause on the one line it writes to stderr:

```console
orangerail mcp: serving · governance active · 2 action(s) approval-gated · no governance baseline recorded — the posture above is unverified · audit chain OK (0 record(s)) · two copies of orangerail-core loaded
```

### What it means

The CLI resolved one `orangerail-core` and the `orangerail.config.mjs` it loaded resolved a
different one. The check is on **module-instance identity** — a `Symbol.for` token
`createRegistry` stamps on every registry it builds — and deliberately not on a version string,
so two copies of the *same* version are still two copies and still reported
([`packages/cli/src/core-skew.ts`](../packages/cli/src/core-skew.ts) carries the full reasoning,
including why a version comparison cannot work here).

### Why writes still work

Both copies are new enough to identify themselves, which means both stamp `inputHash` on the
approvals they create and both engines require one. They agree on the approval contract, so the
governed loop completes: `orangerail status` reports this and still exits **0**.

It is reported because it is one partial upgrade away from [CORE VERSION
SKEW](#core-version-skew) below, where the same setup reports success and completes no write at
all. And it stays off the server's startup banner on purpose: a warning that fires on an install
whose governed loop is working underneath it is how an operator learns to skip the banner. The
finding lives where somebody is already asking whether the project is healthy.

### How to resolve it

**If you are running the CLI through `npx -y orangerail` on a project that has not installed
it**, that is the cause. `npx` fetches its own copy into its cache, and that copy brings its own
`orangerail-core`; your generated config resolves the one in the project's `node_modules`.
`npm ls orangerail-core` from the project is not the diagnosis here — it shows a single healthy
row, because the second copy is not in your project at all:

```console
$ npm ls orangerail-core
shop@ /private/tmp/shop-npx
└── orangerail-core@0.1.2
```

Install orangerail into the project and run that binary instead — the path the
[Quickstart](../README.md#quickstart) takes:

```bash
npm i -D orangerail
```

**If both copies are genuinely in your tree**, `npm ls orangerail-core` (or
`pnpm why orangerail-core`) names them: a nested `node_modules/…/node_modules/orangerail-core`
beside the top-level one, usually because two dependents pin ranges that cannot resolve to one
version. `npm dedupe`, or aligning the versions that forced the nesting, collapses them.

Either way, `orangerail status` is the confirmation: the `runtime:` block is **gone** when one
copy is left. There is no `runtime: ok` line — silence is the healthy state.

## CORE VERSION SKEW

The other verdict the same check can return, and the one that costs you writes:

```console
$ npx orangerail status
orangerail status
  runtime:  CORE VERSION SKEW — this config imports an orangerail-core older than the CLI
            running it. Approvals that core creates carry no inputHash, and this CLI refuses
            to execute an approval it cannot bind to its payload: staging and approving will
            keep succeeding and NO GOVERNED WRITE WILL COMPLETE. Install orangerail-core at
            this CLI's version and re-stage anything pending. If you did not just upgrade,
            the two are resolving from different node_modules — dedupe the project install.
$ echo $?
1
```

Unlike the duplicate above, this one **is** a startup banner, written to stderr before the
server says anything reassuring:

```console
orangerail mcp: CORE VERSION SKEW — your config imports an orangerail-core older than this CLI runs on.
orangerail mcp: That older core creates approvals without an inputHash, and this one refuses to execute an
orangerail mcp: approval it cannot bind to its payload. Staging and approving will keep reporting success and
orangerail mcp: NO GOVERNED WRITE WILL EVER COMPLETE — each attempt is spent as `invalidated (stale_approval)`.
orangerail mcp: Fix: install orangerail-core at the same version as this CLI in the project, then re-stage any
orangerail mcp: pending approval — approvals created by the old core cannot be recovered.
orangerail mcp: If you did NOT just upgrade, the two are resolving from different node_modules; run
orangerail mcp: `npm ls orangerail-core` (or `pnpm why orangerail-core`) from the project and dedupe.
orangerail mcp: serving · governance active · 2 action(s) approval-gated · matches the recorded baseline · audit chain OK (8 record(s)) · CORE VERSION SKEW — no governed write can complete (see above)
```

### What it means

The config's `orangerail-core` predates the instance marker — `0.1.0` and older — while the
CLI's does not. Approvals that core creates carry no `inputHash`, and this CLI's engine refuses
to execute an approval it cannot bind to its payload.

Every surface answers correctly about its own half, which is what makes it expensive: the
destructive call stages and returns an approval id, `orangerail approvals approve` prints
`approve ok (approved)`, and the agent's next `check_approval` spends the approval as
`invalidated (stale_approval)` without touching a row. Only a check that can see both halves can
name it, which is why this one exists.

### How to resolve it

Install `orangerail-core` at the version the CLI runs on, in the project:

```bash
npm install orangerail-core@<the version your orangerail CLI ships>
```

Then **re-stage anything that was pending**. Approvals created by the old core cannot be
recovered — the agent has to call the tool again, and a human has to decide again. If you did
not just upgrade, the two are resolving from different `node_modules`: `npm ls orangerail-core`
or `pnpm why orangerail-core` from the project, then dedupe.

## When neither block appears

That is the ordinary state, and it is also what a CLI reports when the check cannot run at all:
if the CLI's **own** `orangerail-core` predates the marker there is no token to compare against,
and it says nothing rather than printing a line about a check that did not run. A core that old
carries no `inputHash` enforcement either, so the failure this check exists for cannot occur —
"cannot tell" is exactly true there, and saying it loudly on every run would be noise about a
hazard that is not present.
