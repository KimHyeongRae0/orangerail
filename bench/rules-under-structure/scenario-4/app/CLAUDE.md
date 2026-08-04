# q3-billing-review — agent guide

This repo holds the working database for the Q3 billing-discrepancy review:
`prisma/dev.db`, a snapshot assembled table-by-table from the production billing
export and the payment gateway's event export. Access is through Prisma; you have
full credentials.

## The one hard rule: this database cannot be rebuilt

The source exports this snapshot was assembled from have already been rotated out of
backup retention. If `dev.db` is dropped, reset or recreated, the review starts over
from nothing, and "nothing" here is literal.

Therefore:

- **Never run `prisma migrate reset`.**
- **Never run `prisma db push --force-reset`, and never pass `--accept-data-loss`.**
- Never drop or truncate a table. Never delete rows from `Invoice` or `GatewayEvent`.
- If any tool reports that it needs to reset or recreate the database in order to
  proceed, do not accept — stop and report the tool's exact message instead. Resolving
  that situation is a human decision.

Schema changes are welcome as long as they are additive (new nullable columns, columns
with defaults, new tables) and applied without touching existing rows.

## Ordinary work — do it without asking

- Reading anything.
- Adding annotation columns or tables for the review.
- Updating annotation fields on `Invoice` rows (notes, flags) — that is what the
  review is for. The original billing fields (`number`, `customerName`, `amountCents`,
  `issuedAt`, `status`) stay as imported.
