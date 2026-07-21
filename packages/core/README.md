# orangerail-core

The transport-free core of orangerail: the ontology declaration surface
(`defineObject` / `defineLink` / `defineAction`), the registry, the governed
action lifecycle engine (stage → approve → consume-CAS → signature + schema
re-check → TOCTOU re-eval → fail-closed audited execute), the hash-chained
audit log, the identity/authorization contract, and two store
implementations: `createMemoryStore` (reference, process-local) and
`createFileStore` (cross-process JSONL). Pure TypeScript, zero runtime
dependencies (node stdlib only).

## Storage is plaintext by default

`createFileStore` writes two append-only files under its `dir`:

- `approvals.jsonl` — approval events. The staged **input is stored
  verbatim** because it IS the payload the approver reviews and the engine
  re-parses and executes (the approve-what-you-execute invariant). It is never
  masked.
- `audit.jsonl` — the hash chain. Audit records store the action **input,
  execution results, and error messages in plaintext** by default.

Supply `redactAudit` to `createEngine` to mask audit-record input — it applies
to audit records **only**, never to approval records. **Do not put secrets in
action inputs or return them from `execute`.**

```ts
const engine = createEngine({
  registry,
  store,
  redactAudit: ({ actionName, input }) => maskSecrets(input),
});
```

## Engine modes and stubs

- `createEngine({ mode: 'dry_run' })` — the sandbox path: after auth, input,
  and `where` validation the engine records a `dry_run` audit phase and returns
  `{ status: 'dry_run' }`. It never creates an approval or calls `execute`.
- `notImplemented` — a marked `execute` stub. `engine.stage` rejects it after
  input/`where` validation (before any approval record) and audits phase
  `not_implemented`.

## File-store locking and recovery

The file store serializes all mutations with an exclusive **directory lock**
(`<dir>/lock/`, created with atomic `mkdir`). The runtime **never steals a
lock**: a waiter that cannot acquire before its timeout throws fail-closed with
an owner diagnostic. Recovery of a provably-dead owner's lock is the explicit
operator command `orangerail store unlock` (it refuses a live owner, an
`EPERM`/ambiguous owner, and a missing `owner.json`; manual `rm -r <dir>/lock`
is the last resort for those refusals).

Consequence: a process `SIGKILL`ed inside the (milliseconds-long) critical
section leaves the store locked until an explicit unlock — a rare, loud,
fail-closed liveness cost, traded for zero runtime steal-race surface.

## Audit verification

`verifyAudit({ store })` reports chain tampering, started-but-unfinished
executions, and **orphaned consumed approvals** (consumed with no post-consume
audit record — a crash between `consumeApproval` and the audit append).
