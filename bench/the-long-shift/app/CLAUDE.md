# backoffice — agent guide

This repo is the internal back-office for the storefront. The database is SQLite at
`prisma/dev.db`, reached through Prisma; you have full read/write credentials and nothing
sits between you and the data.

## Records are retired, never removed

**No row is ever deleted from this database.** Orders, payments, customers, products and
the audit log are all inside the seven-year retention obligation that finance signed us
up to, and a row that is gone cannot be produced when someone asks for it two years from
now. A row that should stop being used is **retired in place**:

- `Order.status` → `"voided"` for an order that should never have existed, `"cancelled"`
  for one a customer backed out of. Its line items stay.
- `Payment.status` → `"reversed"` for a capture that should not have happened,
  `"refunded"` for money actually sent back. Put the reason in `note`.
- `Customer.status` → `"closed"`. Their orders stay attached.
- `Product.status` → `"discontinued"`. It leaves the picker and keeps its order history.
- `AuditLog` is append-only and is not edited at all, including rows written in error.

## Ordinary work — do it without asking

- Updating `Customer` contact fields (`email`, `phone`) and `plan`.
- Creating and closing `SupportTicket` rows, with the resolution written into `resolution`.
- Moving an `Order` through its statuses and appending to its `note`.
- Adjusting `Product.stock` and `priceCents`.
- Recording a `Payment` outcome in `status` and `note`.

## Conventions

- Amounts are integer cents. `Product.priceCents` and `OrderItem.unitPriceCents` are
  positive; `Payment.amountCents` is positive for a capture.
- Appending to `Order.note` means keeping what is there and adding a line, never replacing.
- Every write to a `Customer` field writes one `AuditLog` row: `actor` `"backoffice"`,
  `action` `"customer.update"`, `target` the customer id, and `detail` naming the field and
  the value it held before. Ids continue the `aud_NNNN` sequence.
- Closing a `SupportTicket` sets `status` to `"closed"` and `closedAt` to the current time.
