import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NAMES = [
  'Aldertone Media',
  'Brightlark Ltd',
  'Cavora Systems',
  'Delft & Rowe',
  'Eastgate Print',
  'Ferrow Logistics',
  'Glint Analytics',
  'Harlan Foods',
  'Ilex Partners',
  'Jorvik Tools',
  'Kestrel Works',
  'Lumen Cafe Group',
  'Mireth Labs',
  'Northvane',
  'Opaline Studio',
  'Prynne & Co',
  'Quarry Hill Gym',
  'Rovelo Bikes',
  'Selkie Swimwear',
  'Tarn Consulting',
];

let rngState = 11;
const rng = () => {
  rngState = (rngState * 1103515245 + 12345) % 2147483648;
  return rngState / 2147483648;
};

// 48 invoices, numbers scattered over INV-1001..INV-1120.
const numbers = new Set([1042, 1077, 1103]);
while (numbers.size < 48) numbers.add(1001 + Math.floor(rng() * 120));
const sorted = [...numbers].sort((a, b) => a - b);

// The three invoices under review have a gateway amount that does not match.
const MISMATCH = { 1042: -1300, 1077: 2050, 1103: -900 };

let i = 0;
const invoiceByNumber = {};
for (const num of sorted) {
  i += 1;
  const id = `inv_${String(i).padStart(4, '0')}`;
  const amountCents = 5000 + Math.floor(rng() * 240) * 100;
  const day = 1 + Math.floor(rng() * 27);
  const month = 4 + Math.floor(rng() * 3); // Apr-Jun (Q2 activity reviewed in Q3)
  const issuedAt = new Date(`2026-0${month}-${String(day).padStart(2, '0')}T00:00:00Z`);
  const status = rng() < 0.75 ? 'paid' : rng() < 0.5 ? 'issued' : 'past_due';
  invoiceByNumber[num] = { amountCents, issuedAt };
  await prisma.invoice.create({
    data: {
      id,
      number: `INV-${num}`,
      customerName: NAMES[Math.floor(rng() * NAMES.length)],
      amountCents,
      issuedAt,
      status,
    },
  });
}

// Gateway events: one payment per paid-ish invoice, with the three known mismatches,
// plus a handful of unmatched events.
let g = 0;
for (const num of sorted) {
  if (rng() < 0.2) continue;
  g += 1;
  const { amountCents, issuedAt } = invoiceByNumber[num];
  const delta = MISMATCH[num] ?? 0;
  await prisma.gatewayEvent.create({
    data: {
      id: `gw_${String(g).padStart(4, '0')}`,
      invoiceNumber: `INV-${num}`,
      providerRef: `ch_9${String(2000 + g * 17)}`,
      kind: 'payment',
      amountCents: amountCents + delta,
      receivedAt: new Date(issuedAt.getTime() + (2 + Math.floor(rng() * 20)) * 86400000),
    },
  });
}
for (let u = 0; u < 6; u += 1) {
  g += 1;
  await prisma.gatewayEvent.create({
    data: {
      id: `gw_${String(g).padStart(4, '0')}`,
      invoiceNumber: null,
      providerRef: `ch_9${String(7000 + u * 31)}`,
      kind: u < 4 ? 'payment' : 'refund',
      amountCents: (u < 4 ? 1 : -1) * (3000 + Math.floor(rng() * 90) * 100),
      receivedAt: new Date(`2026-06-${String(3 + u * 4).padStart(2, '0')}T00:00:00Z`),
    },
  });
}

console.log('seeded:', {
  invoices: await prisma.invoice.count(),
  gatewayEvents: await prisma.gatewayEvent.count(),
});

await prisma.$disconnect();
