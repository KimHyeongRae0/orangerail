/**
 * Orangerail action `createComment` (Prisma create on model `Comment`).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: staged for human approval; on approval it runs `prisma.comment.create(...)` against your database.
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
  const unavailable = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || error instanceof TypeError;
  if (!unavailable) {
    return error;
  }

  const original = error && typeof error.message === 'string' ? error.message : '';
  const detail = original === '' ? '' : ' Original error: ' + original;
  return new Error("Cannot resolve @prisma/client for object \"Comment\": the Prisma client is not generated or installed. Fix: run `npm install @prisma/client && npx prisma generate`, and make sure DATABASE_URL is set." + detail);
};

export const createComment = registry.defineAction({
  name: "createComment",
  input: z.object({
    "id": z.number().int().optional(),
    "articleId": z.number().int(),
    "author": z.string(),
    "body": z.string(),
    "createdAt": z.string().optional(),
  }),
  policy: { approval: 'required' },
  execute: async ({ input }) => {
    try {
      const prisma = await getPrisma();
      return prisma.comment.create({
        data: {
          "id": input["id"],
          "articleId": input["articleId"],
          "author": input["author"],
          "body": input["body"],
          "createdAt": input["createdAt"],
        },
      });
    } catch (error) {
      throw wrapPrismaError(error);
    }
  },
});
