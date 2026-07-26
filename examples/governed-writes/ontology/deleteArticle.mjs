/**
 * Orangerail action `deleteArticle` (Prisma delete on model `Article`).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: staged for human approval; on approval it runs `prisma.article.delete(...)` against your database.
 * DESTRUCTIVE: permanently deletes a `Article` row on approval — an approver should confirm the identifier before authorizing.
 */
import { z } from 'zod';

import { registry } from './_registry.mjs';
import { Article } from './Article.mjs';

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
  const unavailable = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || error instanceof TypeError;
  if (!unavailable) {
    return error;
  }

  const original = error && typeof error.message === 'string' ? error.message : '';
  const detail = original === '' ? '' : ' Original error: ' + original;
  return new Error("Cannot resolve @prisma/client for object \"Article\": the Prisma client is not generated or installed. Fix: run `npm install @prisma/client && npx prisma generate`, and make sure DATABASE_URL is set." + detail);
};

export const deleteArticle = registry.defineAction({
  name: "deleteArticle",
  input: z.object({
    "id": z.number().int(),
  }),
  policy: { approval: 'required' },
  target: Article,
  targetIdFrom: "id",
  execute: async ({ input }) => {
    try {
      const prisma = await getPrisma();
      return prisma.article.delete({ where: { "id": input["id"] } });
    } catch (error) {
      throw wrapPrismaError(error);
    }
  },
});
