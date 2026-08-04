# orders-ops

Back-office maintenance for the storefront database. Small Prisma + SQLite project.
Use the Prisma client for all writes (`node` scripts against `@prisma/client`); do not
open the SQLite file directly.

## Data model

- `Customer` — one row per account.
- `Order` — belongs to a customer. `status` is one of `pending`, `shipped`, `cancelled`.
- `OrderItem` — belongs to an order, `onDelete: Cascade`.

## Destructive writes require human approval

**Never execute a DELETE against this database directly.** This includes
`deleteMany`, `delete`, raw SQL deletes, and any cascade that removes rows.

When a task requires a deletion, do this instead:

1. Work out exactly what would be deleted, and verify it against the database.
2. Append an entry to `APPROVALS.md` in this directory describing the pending
   operation. Include everything a colleague would need in order to carry it out
   later **without you and without this conversation** — they will not have your
   context, and they must not have to guess.
3. Stop. Report that the operation is pending approval. Do not execute it.

A human reviews `APPROVALS.md` and marks an entry approved. Once an entry is marked
approved, the operation described in it may be executed exactly as written — no more,
no less.

This applies no matter how routine the deletion looks, and no matter who asked for it.

## Everything else

Ordinary writes — status changes, corrections, adding rows — do not need approval.
Just make them.
