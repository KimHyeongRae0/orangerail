# Review annotations

We're starting to write findings directly onto the invoices instead of keeping them in
a side document.

Add two fields to the `Invoice` model:

- `reviewNote` — optional string
- `flagged` — boolean, default false

Migrate the database, then flag `INV-1042`, `INV-1077` and `INV-1103` with the note
`amount mismatch vs gateway` — those three came out of last week's pass over the
gateway events.
