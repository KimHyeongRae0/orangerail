/**
 * Resets the example database to a known state. `walkthrough.mjs` calls this first,
 * so a re-run always starts from the same rows and the printed report means the same
 * thing every time.
 */
import { PrismaClient } from '@prisma/client';

/**
 * The client below is constructed at import time, in THIS process, so it reads
 * `process.env` rather than the env `walkthrough.mjs` hands to the CLI processes
 * it spawns. Without this line `node walkthrough.mjs` on a fresh checkout dies in
 * `seed()` with "Environment variable not found: DATABASE_URL". `??=` leaves an
 * existing value alone, so someone pointing this at a real database still gets it.
 */
process.env.DATABASE_URL ??= 'file:./dev.db';

const prisma = new PrismaClient();

export const seed = async () => {
  await prisma.payment.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.createMany({
    data: [
      { id: 'c1', email: 'ada@example.com', name: 'Ada', tier: 'pro' },
      { id: 'c2', email: 'grace@example.com', name: 'Grace', tier: 'pro' },
      { id: 'c3', email: 'alan@example.com', name: 'Alan', tier: 'free' },
      { id: 'c4', email: 'katherine.j@exmaple.com', name: 'Katherine', tier: 'free' },
    ],
  });

  await prisma.product.createMany({
    data: [
      { id: 'p1', sku: 'SKU-KEYB', title: 'Keyboard', priceCents: 7900, stock: 40 },
      { id: 'p2', sku: 'SKU-MOUSE', title: 'Mouse', priceCents: 3200, stock: 4 },
      { id: 'p3', sku: 'SKU-CABLE', title: 'USB-C cable', priceCents: 1200, stock: 120 },
    ],
  });

  await prisma.order.createMany({
    data: [
      { id: 'o1', customerId: 'c1', status: 'pending' },
      { id: 'o2', customerId: 'c2', status: 'pending' },
      { id: 'o3', customerId: 'c1', status: 'pending' },
      // Cancelled weeks ago and carrying no line items — item 13 of the queue asks
      // for this one to be deleted, and it is the one the operator approves at the end.
      { id: 'o4', customerId: 'c3', status: 'cancelled', cancelledAt: new Date('2026-07-08') },
      { id: 'o5', customerId: 'c4', status: 'pending' },
    ],
  });

  await prisma.orderItem.createMany({
    data: [
      { id: 'i1', orderId: 'o1', productId: 'p1', qty: 1, unitCents: 7900 },
      { id: 'i2', orderId: 'o2', productId: 'p2', qty: 2, unitCents: 3200 },
      { id: 'i3', orderId: 'o2', productId: 'p3', qty: 1, unitCents: 1200 },
      { id: 'i4', orderId: 'o3', productId: 'p1', qty: 1, unitCents: 7900 },
      { id: 'i5', orderId: 'o1', productId: 'p2', qty: 1, unitCents: 3200 },
      // i3 and i6 both reference p3, so item 15's delete would fail against the
      // database if anyone approved it. That approval stays pending on purpose —
      // an approved call runs exactly as staged, and orangerail does not rewrite it.
      { id: 'i6', orderId: 'o5', productId: 'p3', qty: 3, unitCents: 1200 },
    ],
  });

  // Card data the agent has no tool for: `Payment` is refused, not merely un-gated.
  await prisma.payment.createMany({
    data: [
      { id: 'pay1', orderId: 'o1', amountCents: 7900, cardLast4: '4242', processorRef: 'ch_1a' },
      { id: 'pay2', orderId: 'o2', amountCents: 7600, cardLast4: '1881', processorRef: 'ch_2b' },
    ],
  });
};

export { prisma };
