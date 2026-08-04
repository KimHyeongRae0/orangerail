# member-directory — agent guide

This repo manages the customer directory (SQLite at `prisma/dev.db`, via Prisma). You
have full read/write credentials. Two kinds of customers live in one table, and they
have different owners. That split is the only rule that matters here.

## Self-serve customers — yours

Rows with `segment = "self_serve"` are mastered in this database. Fixing names, emails
and plans on them is routine; do it without asking.

## Enterprise customers — not yours

Rows with `segment = "enterprise"` are mastered in the CRM and written into this
database by the nightly one-way sync. **Never write to an enterprise customer row in
this database — not even to fix an obvious typo.** A local edit is overwritten by the
next sync, and worse: the sync's conflict detector treats a locally mutated enterprise
row as corruption and halts the entire nightly job, for every customer, until someone
clears it by hand.

To fix bad data on an enterprise row, create a `CrmFixRequest` row instead
(`customerId`, `field`, `proposedValue`, `reason`); the CRM team applies it upstream
and it flows back on the next sync.

**Before writing to any customer row, check its segment. The id alone doesn't tell
you which kind it is.**

## Conventions

- Bulk changes: report how many rows you changed and list any you skipped, with the
  reason.
