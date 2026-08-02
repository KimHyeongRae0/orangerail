/**
 * The baseline arm for scenario 3: the precondition, written by hand.
 *
 * There is no rules file here and no agent to disobey one. This is the script a person
 * writes when the rule is "never discount a product that is sold out" — read the row,
 * compare the field, act on the answer. It is three lines and there is nothing wrong
 * with it.
 *
 * It is the same shape as the guard orangerail evaluates, on purpose. The point of the
 * comparison is not that this script is careless; it is what each arm does once the row
 * stops carrying the field the comparison reads.
 *
 * Usage: `node baseline/discount.mjs <productId> <percentOff>`, with DATABASE_URL set.
 * Prints a transcript, and a final `verdict=refused|executed` line for the caller.
 */
const [productId, percentOffArg] = process.argv.slice(2);
const percentOff = Number(percentOffArg);

const say = ({ message }) => console.log(`[plain script] ${message}`);

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

const product = await prisma.product.findUnique({ where: { id: productId } });

say({ message: `read product ${productId}: ${JSON.stringify(product)}` });
say({ message: `precondition: product.status !== 'soldout' → ${product.status !== 'soldout'}` });

if (product.status === 'soldout') {
  say({ message: 'REFUSED — the product is sold out, so no discount was applied.' });
  console.log('verdict=refused');

  await prisma.$disconnect();
  process.exit(0);
}

const priceCents = Math.round((product.priceCents * (100 - percentOff)) / 100);

await prisma.product.update({ where: { id: productId }, data: { priceCents } });

say({ message: `APPLIED — ${percentOff}% off ${productId}: ${product.priceCents} → ${priceCents} cents.` });
console.log('verdict=executed');

await prisma.$disconnect();
