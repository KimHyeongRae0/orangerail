/**
 * Orangerail object `Article` (Prisma model Article).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 */
import { z } from 'zod';

import { registry } from './_registry.mjs';

const getPrisma = (() => {
  let client;
  return async () => {
    if (client === undefined) {
      const { PrismaClient } = await import('@prisma/client');
      client = new PrismaClient();
    }
    return client;
  };
})();

const wrapPrismaError = (error) => {
  const code = error === null || error === undefined ? undefined : error.code;
  const missing = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
  if (!missing && !(error instanceof TypeError)) {
    return error;
  }

  const original = error && typeof error.message === 'string' ? error.message : '';
  const detail = original === '' ? '' : ' Original error: ' + original;
  return new Error((missing ? "Cannot resolve @prisma/client for object \"Article\": the Prisma client is not generated or installed. Fix: run `npm install @prisma/client && npx prisma generate`, and make sure DATABASE_URL is set." : "The Prisma client exposes no \"article\" model for object \"Article\": the installed client was generated from a different schema. Fix: confirm the model still exists in your Prisma schema, then re-run `npx prisma generate`.") + detail);
};

export const Article = registry.defineObject({
  name: "Article",
  schema: z.object({
    "id": z.number().int(),
    "slug": z.string(),
    "title": z.string(),
    "body": z.string(),
    "published": z.boolean(),
    "createdAt": z.string(),
  }),
  resolve: {
    get: async ({ id }) => {
      try {
        const prisma = await getPrisma();
        const key = Number(id);
        if (Number.isNaN(key)) {
          return null;
        }
        return prisma.article.findUnique({ where: { "id": key } });
      } catch (error) {
        throw wrapPrismaError(error);
      }
    },
    list: async ({ filter, cursor, limit } = {}) => {
      try {
        const prisma = await getPrisma();
        const take = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50;
        const rows = await prisma.article.findMany({
          ...(filter ? { where: filter } : {}),
          orderBy: { "id": 'asc' },
          take: take + 1,
          ...(cursor === undefined ? {} : { cursor: { "id": Number(cursor) }, skip: 1 }),
        });
        const hasMore = rows.length > take;
        const items = hasMore ? rows.slice(0, take) : rows;
        return hasMore ? { items, nextCursor: String(items[items.length - 1]["id"]) } : { items };
      } catch (error) {
        throw wrapPrismaError(error);
      }
    },
  },
});
