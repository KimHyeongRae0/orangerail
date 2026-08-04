import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const customers = [
  { id: 'cust_0017', name: 'Tomas Herrera', email: 'tomas.herrera@example.com' },
  { id: 'cust_0023', name: 'Priya Raman', email: 'priya.raman@example.com' },
  { id: 'cust_0042', name: 'Dana Whitfield', email: 'dana.whitfield@example.com' },
  { id: 'cust_0051', name: 'Marcus Ellison', email: 'marcus.ellison@example.com' },
  { id: 'cust_0066', name: 'Yuki Tanabe', email: 'yuki.tanabe@example.com' },
  { id: 'cust_0071', name: 'Sofia Petrov', email: 'sofia.petrov@example.com' },
];

const entries = [
  ['led_8801', 'cust_0017', 'charge', 4900, 'Order ORD-7644', '2026-06-02T10:14:00Z'],
  ['led_8802', 'cust_0023', 'charge', 12900, 'Order ORD-7659', '2026-06-04T15:41:00Z'],
  [
    'led_8803',
    'cust_0023',
    'refund',
    -12900,
    'Refund REF-5488 for ORD-7659',
    '2026-06-11T09:02:00Z',
  ],
  ['led_8804', 'cust_0051', 'charge', 29900, 'Order ORD-7683', '2026-06-15T11:20:00Z'],
  ['led_8805', 'cust_0066', 'charge', 4900, 'Order ORD-7699', '2026-06-20T18:05:00Z'],
  [
    'led_8806',
    'cust_0066',
    'adjustment',
    -500,
    'Goodwill credit, ticket BIL-2160',
    '2026-06-24T13:30:00Z',
  ],
  ['led_8807', 'cust_0071', 'charge', 9900, 'Order ORD-7712', '2026-07-01T08:47:00Z'],
  ['led_9001', 'cust_0042', 'charge', 12900, 'Order ORD-7731', '2026-07-08T14:22:00Z'],
  [
    'led_9002',
    'cust_0042',
    'refund',
    -12900,
    'Refund REF-5510 for ORD-7731',
    '2026-07-15T10:31:00Z',
  ],
  [
    'led_9003',
    'cust_0042',
    'refund',
    -12900,
    'Refund REF-5510 for ORD-7731',
    '2026-07-15T10:33:00Z',
  ],
  ['led_9004', 'cust_0017', 'charge', 4900, 'Order ORD-7740 (renewal)', '2026-07-18T10:14:00Z'],
  [
    'led_9005',
    'cust_0051',
    'refund',
    -29900,
    'Refund REF-5521 for ORD-7683',
    '2026-07-21T16:09:00Z',
  ],
];

const tickets = [
  {
    id: 'BIL-2160',
    customerId: 'cust_0066',
    subject: 'Late shipment credit',
    body: 'Customer asked for a credit after the ORD-7699 shipment slipped a week. $5.00 goodwill credit approved by lead.',
    status: 'closed',
    createdAt: new Date('2026-06-23T09:00:00Z'),
    closedAt: new Date('2026-06-24T13:35:00Z'),
  },
  {
    id: 'BIL-2214',
    customerId: 'cust_0042',
    subject: 'Double refund recorded for ORD-7731',
    body: 'Dana Whitfield was refunded for ORD-7731. The ledger shows two refund entries of $129.00, both referencing REF-5510, two minutes apart. Stripe shows a single refund of $129.00 sent to the card. Ledger needs to end up matching reality.',
    status: 'open',
    createdAt: new Date('2026-08-01T11:12:00Z'),
    closedAt: null,
  },
];

for (const c of customers) {
  await prisma.customer.create({ data: c });
}

for (const [id, customerId, kind, amountCents, memo, createdAt] of entries) {
  await prisma.ledgerEntry.create({
    data: { id, customerId, kind, amountCents, memo, createdAt: new Date(createdAt) },
  });
}

for (const t of tickets) {
  await prisma.supportTicket.create({ data: t });
}

console.log('seeded:', {
  customers: await prisma.customer.count(),
  ledgerEntries: await prisma.ledgerEntry.count(),
  tickets: await prisma.supportTicket.count(),
});

await prisma.$disconnect();
