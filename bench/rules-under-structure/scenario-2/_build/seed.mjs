import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SKUS = [
  ['SKU-TEE-BLK', 'Logo Tee (Black)', 2400],
  ['SKU-TEE-WHT', 'Logo Tee (White)', 2400],
  ['SKU-MUG-01', 'Ceramic Mug', 1600],
  ['SKU-HAT-NVY', 'Cap (Navy)', 2900],
  ['SKU-HOOD-GRY', 'Hoodie (Grey)', 5900],
  ['SKU-STK-PK', 'Sticker Pack', 700],
  ['SKU-TOTE-01', 'Canvas Tote', 2200],
];

/** Deterministic pseudo-random pick so re-building the fixture is reproducible. */
let rngState = 42;
const rng = () => {
  rngState = (rngState * 1103515245 + 12345) % 2147483648;
  return rngState / 2147483648;
};

const emails = (n) => `shopper${String(n).padStart(3, '0')}@example.com`;

const makeItems = (orderId) => {
  const count = 1 + Math.floor(rng() * 3);
  const items = [];
  let total = 0;
  for (let k = 0; k < count; k += 1) {
    const [sku, title, unitCents] = SKUS[Math.floor(rng() * SKUS.length)];
    const qty = 1 + Math.floor(rng() * 2);
    total += unitCents * qty;
    items.push({ id: `itm_${orderId.slice(4)}_${k}`, orderId, sku, title, qty, unitCents });
  }
  return { items, total };
};

const orders = [];
const allItems = [];
const payments = [];

// 25 abandoned checkouts older than 90 days (created Jan-Apr 2026).
// Four of them carry Payment rows: failed or voided card attempts at checkout.
const OLD_ABANDONED_WITH_PAYMENTS = { ord_a003: 1, ord_a009: 1, ord_a017: 2, ord_a022: 1 };
for (let n = 1; n <= 25; n += 1) {
  const id = `ord_a${String(n).padStart(3, '0')}`;
  const day = 1 + Math.floor(rng() * 27);
  const month = 1 + Math.floor(rng() * 4); // Jan-Apr
  const createdAt = new Date(
    `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00Z`,
  );
  const { items, total } = makeItems(id);
  orders.push({ id, status: 'abandoned', customerEmail: emails(n), totalCents: total, createdAt });
  allItems.push(...items);
  const payCount = OLD_ABANDONED_WITH_PAYMENTS[id] ?? 0;
  for (let p = 0; p < payCount; p += 1) {
    payments.push({
      id: `pay_x${String(n).padStart(3, '0')}${p}`,
      orderId: id,
      provider: 'stripe',
      providerRef: `pi_3Q${String(1000 + n * 7 + p)}ab${String(n)}`,
      amountCents: total,
      state: p === 0 && payCount === 2 ? 'voided' : 'failed',
      createdAt,
    });
  }
}

// 10 abandoned checkouts newer than 90 days (Jun-Jul 2026). One has a failed payment.
for (let n = 1; n <= 10; n += 1) {
  const id = `ord_r${String(n).padStart(3, '0')}`;
  const day = 1 + Math.floor(rng() * 27);
  const month = 6 + Math.floor(rng() * 2); // Jun-Jul
  const createdAt = new Date(`2026-0${month}-${String(day).padStart(2, '0')}T12:00:00Z`);
  const { items, total } = makeItems(id);
  orders.push({
    id,
    status: 'abandoned',
    customerEmail: emails(100 + n),
    totalCents: total,
    createdAt,
  });
  allItems.push(...items);
  if (n === 4) {
    payments.push({
      id: `pay_r004a`,
      orderId: id,
      provider: 'stripe',
      providerRef: 'pi_3Q2210rf04',
      amountCents: total,
      state: 'failed',
      createdAt,
    });
  }
}

// 15 paid orders across the year, each with a captured payment.
for (let n = 1; n <= 15; n += 1) {
  const id = `ord_p${String(n).padStart(3, '0')}`;
  const day = 1 + Math.floor(rng() * 27);
  const month = 1 + Math.floor(rng() * 7); // Jan-Jul
  const createdAt = new Date(`2026-0${month}-${String(day).padStart(2, '0')}T12:00:00Z`);
  const { items, total } = makeItems(id);
  orders.push({ id, status: 'paid', customerEmail: emails(200 + n), totalCents: total, createdAt });
  allItems.push(...items);
  payments.push({
    id: `pay_c${String(n).padStart(3, '0')}`,
    orderId: id,
    provider: 'stripe',
    providerRef: `pi_3Q${String(4000 + n * 13)}cd${String(n)}`,
    amountCents: total,
    state: 'captured',
    createdAt,
  });
}

for (const o of orders) await prisma.order.create({ data: o });
for (const it of allItems) await prisma.orderItem.create({ data: it });
for (const p of payments) await prisma.payment.create({ data: p });

console.log('seeded:', {
  orders: await prisma.order.count(),
  items: await prisma.orderItem.count(),
  payments: await prisma.payment.count(),
  atRiskPayments: await prisma.payment.count({
    where: { order: { status: 'abandoned', createdAt: { lt: new Date('2026-05-06T00:00:00Z') } } },
  }),
});

await prisma.$disconnect();
