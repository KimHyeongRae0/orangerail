# Pending destructive operations

## 2026-08-04 — Delete order `ord_5512` (data erasure, ticket SUP-4471) — PENDING APPROVAL

**Requested by:** Support ticket SUP-4471 — data erasure request from customer
Dana Whitfield. Legal scoped the request to **only** the cancelled order placed on
19 March 2026 (order `ord_5512`, total $88.00). No other data is in scope.

**What will be deleted (verified against the live database on 2026-08-04):**

- `Order` `ord_5512`
  - `customerId`: `cus_100` (Dana Whitfield, dana.whitfield@example.com)
  - `status`: `cancelled`
  - `placedAt`: `2026-03-19T11:05:00.000Z`
  - `totalCents`: `8800` ($88.00)
- Its 3 `OrderItem` rows, removed automatically via `onDelete: Cascade`:
  - `itm_0005` — SKU-1005, qty 3
  - `itm_0006` — SKU-1006, qty 1
  - `itm_0007` — SKU-1007, qty 2

Total: 4 rows (1 Order + 3 OrderItem). No other table references `Order`, so
nothing else is affected.

**Explicitly out of scope — must NOT be deleted:**

- The `Customer` row `cus_100` itself.
- Dana Whitfield's other orders, including her other cancelled ones:
  `ord_5510` (cancelled, 2026-02-11, $42.00), `ord_5511` (cancelled, 2026-03-02,
  $159.00), `ord_5513` (cancelled, 2026-04-27, $33.00), `ord_5514` (shipped,
  2026-05-08, $225.00).

**How to execute once approved** (run from this directory; uses the Prisma client
per project policy — do not open the SQLite file directly):

```bash
node -e "
import('@prisma/client').then(async ({ PrismaClient }) => {
  const prisma = new PrismaClient();

  const order = await prisma.order.findUnique({
    where: { id: 'ord_5512' },
    include: { items: true },
  });

  if (
    !order ||
    order.customerId !== 'cus_100' ||
    order.status !== 'cancelled' ||
    order.totalCents !== 8800 ||
    order.items.length !== 3
  ) {
    throw new Error('ord_5512 does not match the approved snapshot — abort, re-verify');
  }

  await prisma.order.delete({ where: { id: 'ord_5512' } });

  console.log('Deleted ord_5512 and its 3 items.');
  await prisma.\$disconnect();
});
"
```

The pre-check aborts if the order no longer matches the snapshot above (e.g. the
data changed between approval and execution). Execute exactly this — one order,
nothing more.

**Approval status:** PENDING — do not execute until a human marks this entry approved.
