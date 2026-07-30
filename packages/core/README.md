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

## Prior state on the audit record

An `execution_started` record carries `prior` — the action's target as it stood
immediately before the write. Without it an audit record for a successful update
says what the row is now and cannot say what it was, so the change can be
neither described nor undone from the log.

It costs nothing to declare: the engine reads it through the `target` +
`targetIdFrom` + `resolve.get` the ontology already declares, which is the same
read the `where` gate performs. A gated action pays **no extra round-trip** (the
gate's read is reused); an un-gated one with a readable target pays exactly one.

`prior` is a discriminated union, because a recovery attempt has to tell these
apart: `{ state: 'value', value }`, `{ state: 'none' }` (the read succeeded and
there was no such row), `{ state: 'unreadable', error }` (the read threw — the
write still ran), `{ state: 'withheld' }` (redaction policy, below), and
`{ state: 'unavailable', reason }` (the action declares nothing readable). It is
absent entirely on records written before this feature existed, and `verifyAudit`
never requires it.

It is a witness, **not a transactional snapshot**: it is read on the same
connection as the write but outside its transaction, so a concurrent writer
between the two makes it stale.

**Redaction is a separate hook on purpose.** A prior row carries every column the
object declares, including ones no input ever mentions, so handing it to a
`redactAudit` written against an action's input would mask what that function
happens to know and publish the rest. Supply `redactPrior` to mask rows; supply
`redactAudit` alone and rows are recorded as `{ state: 'withheld' }` rather than
guessed at.

```ts
const engine = createEngine({
  registry,
  store,
  redactAudit: ({ input }) => maskSecrets(input),
  redactPrior: ({ prior }) => ({ ...prior, password_hash: '***' }),
});
```

## Engine modes and stubs

- `createEngine({ mode: 'dry_run' })` — the sandbox path: after auth, input,
  and `where` validation the engine records a `dry_run` audit phase and returns
  `{ status: 'dry_run' }`. It never creates an approval or calls `execute`.
- `notImplemented` — a marked `execute` stub. `engine.stage` rejects it after
  input/`where` validation (before any approval record) and audits phase
  `not_implemented`.

## Failure detail is operator-facing

Every failing engine outcome (`failed`, `resolve_error`, `audit_blocked`)
carries `{ error, correlationId }`. `error` is the FULL underlying text — the
driver message, verbatim, because an operator debugging a write needs the
constraint name. A transport answering an untrusted agent MUST redact it and
return `correlationId` instead (`orangerail-mcp` does).

`correlationId` is the audit lookup key: the `approvalId` when the failure came
from an approval, otherwise the id stamped on that attempt's audit records —
the same key `verifyAudit` pairs records on. So the id the agent quotes is the
id that finds the full text in the log.

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

## Approve-what-you-execute

`createApproval` stamps an `inputHash` over the canonical persisted form of the
staged input, and `execute` recomputes it over the payload it is about to run
before any side effect. `signatureHash` only ever covered the action's
**declared** shape, so without this an input edited in the store between approval
and execution ran unchallenged: the operator approves `harmless-test-widget` and
the engine deletes `PRODUCTION-CUSTOMER-TABLE`.

A store implementation **must** stamp it — one that skips it makes every approval
it creates unexecutable, because `execute` treats an absent hash as unverifiable
and refuses. That is also what happens to an approval persisted by `0.1.0` and
still `pending` across an upgrade: it is consumed and returns
`{ status: 'invalidated', reason: 'input' }`, and must be re-staged. `verifyAudit`
takes the other side of the same fact and does **not** report an absent hash as
tampering — it cannot tell a `0.1.0` record from a stripped one, and that swap is
caught anyway by the staged-vs-executed input comparison on the chain, which needs
no hash.

## Audit verification

`verifyAudit({ store })` walks the chain — each record's `hash` recomputed over
its own content, each `prevHash` linked to the record before it — and checks it
against the anchored `audit.head.json` checkpoint, which catches a tail truncated
off `audit.jsonl` alone. It reports started-but-unfinished executions and
**orphaned consumed approvals** (consumed with no post-consume audit record — a
crash between `consumeApproval` and the audit append).

On top of that walk it cross-checks the approvals store and the audit chain
against each other wherever they overlap — staging, decision, decider, requester,
action, consumption, and the approved payload. The two are independent witnesses,
so neither is trusted on its own and forging one of them is not enough.

**It is not a defense against an attacker with write access to the store
directory.** The chain hash is an unkeyed sha256, `hashAuditRecord` is a public
export of this package, and the anchor is an unsigned JSON file sitting beside the
records it anchors — so both logs can be deleted, re-chained and re-anchored
consistently, and verification will report the result as OK. What these checks
raise is the bar, from "detects careless tampering" to "detects tampering that
does not also forge both logs in agreement", and nothing higher.

The practical consequence is a deployment one: **put the store somewhere the
governed agent cannot write.** `createFileStore({ dir })` takes any path, and
`orangerail init` scaffolds `dir` inside the scanned project — convenient locally,
and the single configuration that most undermines the guarantee once the agent has
file tools over that repo.
