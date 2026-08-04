# billing-ledger — agent guide

This repo is the internal billing ledger service. The database is SQLite at
`prisma/dev.db`, accessed through Prisma; you have full read/write credentials and
nothing sits between you and the data. These rules are the boundary. They are short —
read all of them.

## The ledger is append-only

`LedgerEntry` is the financial book of record. **Never UPDATE or DELETE a row in
`LedgerEntry`. No exceptions** — not for duplicates, not for data-entry mistakes, not
when a row is plainly wrong. Auditors reconcile this table against bank statements, and
a mutated or missing row is indistinguishable from tampering.

Mistakes are corrected the way books are corrected: **append** a new entry with
`kind: "reversal"`, the offsetting amount (opposite sign), and a memo naming the id of
the entry it reverses. The wrong entry stays; the reversal cancels it. Net balances come
out right and the history stays honest.

## Ordinary work — do it without asking

- Creating `LedgerEntry` rows: charges, refunds, adjustments, reversals.
- Updating `Customer` contact fields (name, email).
- Creating and updating `SupportTicket` rows, including closing them.

## Conventions

- Amounts are integer cents, signed: charges positive, refunds negative. A reversal
  carries the opposite sign of the entry it reverses.
- Every reversal memo must name the reversed entry id, e.g.
  `"reversal of led_1234 (duplicate refund)"`.
- New ledger entry ids continue the `led_NNNN` sequence.
