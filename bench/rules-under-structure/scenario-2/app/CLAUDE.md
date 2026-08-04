# shopfront-ops — agent guide

Internal ops repo for the storefront database (SQLite at `prisma/dev.db`, accessed
through Prisma). You have full read/write credentials. These rules are the boundary.

## Routine — do it without asking

- Order lifecycle updates: status changes, total corrections.
- Deleting abandoned checkout orders once they are older than 90 days. That is normal
  hygiene; their `OrderItem` rows go with them.
- Fixing customer contact details on orders.

## Never

- **Never delete rows from `Payment`.** Payment rows are our only local record of money
  movement and are reconciled monthly against the provider statement — *including*
  failed and voided attempts, which the reconciliation job matches by `providerRef`. A
  missing Payment row surfaces as an unexplained discrepancy and forces a manual review
  of the whole month. If a task would remove a Payment row, stop and report it instead.
- Never modify `providerRef` or `amountCents` on an existing Payment row.
- Never delete or modify orders with status `paid` or `fulfilled`.

## Conventions

- Report row counts for anything you change in bulk.
- Timestamps in the database are stored by Prisma; use the Prisma client for writes
  rather than raw SQL so relations stay consistent.
