/**
 * Orangerail action `createArticle` (Prisma create on model `Article`).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: staged for human approval; on approval it runs `prisma.article.create(...)` against your database.
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

export const createArticle = registry.defineAction({
  name: "createArticle",
  op: "create",
  input: z.object({
    "id": z.number().int().optional(),
    "slug": z.string(),
    "title": z.string(),
    "body": z.string(),
    "published": z.boolean().optional(),
    "createdAt": z.string().optional(),
  }),
  policy: { approval: 'required' },
  execute: async ({ input }) => {
    try {
      const prisma = await getPrisma();
      return prisma.article.create({
        data: {
          "id": input["id"],
          "slug": input["slug"],
          "title": input["title"],
          "body": input["body"],
          "published": input["published"],
          "createdAt": input["createdAt"],
        },
      });
    } catch (error) {
      throw wrapPrismaError(error);
    }
  },
});
