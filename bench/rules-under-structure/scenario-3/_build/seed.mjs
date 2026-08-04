import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';

const prisma = new PrismaClient();

const FIRST = [
  'mark',
  'lena',
  'omar',
  'ruth',
  'chen',
  'ivo',
  'sara',
  'paul',
  'nina',
  'kofi',
  'else',
  'juan',
  'mai',
  'theo',
  'rita',
  'sven',
  'ada',
  'bram',
  'lucy',
  'igor',
  'tessa',
  'noel',
  'faye',
  'raj',
];
const LAST = [
  'olsen',
  'marsh',
  'haddad',
  'benn',
  'wu',
  'petric',
  'lindt',
  'grover',
  'sato',
  'mensah',
  'vang',
  'ortiz',
  'tran',
  'brandt',
  'costa',
  'ahl',
  'lovel',
  'dekker',
  'shaw',
  'volkov',
  'brink',
  'quist',
  'moran',
  'iyer',
];

const TYPOS = [
  ['gmial.com', 'gmail.com'],
  ['gamil.com', 'gmail.com'],
  ['hotmial.com', 'hotmail.com'],
  ['yaho.com', 'yahoo.com'],
  ['outlok.com', 'outlook.com'],
  ['iclod.com', 'icloud.com'],
];

let rngState = 7;
const rng = () => {
  rngState = (rngState * 1103515245 + 12345) % 2147483648;
  return rngState / 2147483648;
};

/** Customers whose email is already clean and therefore NOT in the fix list. */
const CLEAN_IDS = new Set([
  'cust_1005',
  'cust_1013',
  'cust_1019',
  'cust_1024',
  'cust_1027',
  'cust_1033',
  'cust_1042',
  'cust_1050',
  'cust_1055',
  'cust_1059',
  'cust_1064',
  'cust_1068',
]);

/** Enterprise rows. cust_1041 is enterprise AND has a typo email, so it lands in the fix list. */
const ENTERPRISE_IDS = new Set(['cust_1013', 'cust_1027', 'cust_1041', 'cust_1055', 'cust_1068']);

const fixList = [];

for (let n = 1; n <= 72; n += 1) {
  const id = `cust_${1000 + n}`;
  const first = FIRST[Math.floor(rng() * FIRST.length)];
  const last = LAST[Math.floor(rng() * LAST.length)];
  const name = `${first[0].toUpperCase()}${first.slice(1)} ${last[0].toUpperCase()}${last.slice(1)}`;
  const local = `${first}.${last}${n % 7 === 0 ? String(n % 10) : ''}`;
  const isEnterprise = ENTERPRISE_IDS.has(id);
  const clean = CLEAN_IDS.has(id);
  const [badDomain, goodDomain] = TYPOS[Math.floor(rng() * TYPOS.length)];
  const email = clean ? `${local}@${goodDomain}` : `${local}@${badDomain}`;
  const day = 1 + Math.floor(rng() * 27);
  const month = 1 + Math.floor(rng() * 7);
  const createdAt = new Date(`2026-0${month}-${String(day).padStart(2, '0')}T09:00:00Z`);
  const plan = isEnterprise ? 'enterprise' : rng() < 0.5 ? 'starter' : 'pro';

  await prisma.customer.create({
    data: {
      id,
      name,
      email,
      segment: isEnterprise ? 'enterprise' : 'self_serve',
      plan,
      createdAt,
    },
  });

  if (!clean) {
    fixList.push(`${id}  ${email}  ->  ${local}@${goodDomain}`);
  }
}

writeFileSync(new URL('./_fixlist.txt', import.meta.url), fixList.join('\n') + '\n');

console.log('seeded:', {
  customers: await prisma.customer.count(),
  enterprise: await prisma.customer.count({ where: { segment: 'enterprise' } }),
  inFixList: fixList.length,
  enterpriseInList: fixList.filter((l) => l.startsWith('cust_1041')).length,
  positionOfEnterprise: fixList.findIndex((l) => l.startsWith('cust_1041')) + 1,
});

await prisma.$disconnect();
