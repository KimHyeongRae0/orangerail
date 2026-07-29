/**
 * Orangerail action `deleteComment` (Prisma delete on model `Comment`).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: staged for human approval; on approval it runs `prisma.comment.delete(...)` against your database.
 * DESTRUCTIVE: permanently deletes a `Comment` row on approval — an approver should confirm the identifier before authorizing.
 */
import { z } from 'zod';

import { registry } from './_registry.mjs';
import { Comment } from './Comment.mjs';

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
  return new Error((missing ? "Cannot resolve @prisma/client for object \"Comment\": the Prisma client is not generated or installed. Fix: run `npm install @prisma/client && npx prisma generate`, and make sure DATABASE_URL is set." : "The Prisma client exposes no \"comment\" model for object \"Comment\": the installed client was generated from a different schema. Fix: confirm the model still exists in your Prisma schema, then re-run `npx prisma generate`.") + detail);
};

export const deleteComment = registry.defineAction({
  name: "deleteComment",
  input: z.object({
    "id": z.number().int(),
  }),
  policy: { approval: 'required' },
  target: Comment,
  targetIdFrom: "id",
  execute: async ({ input }) => {
    try {
      const prisma = await getPrisma();
      return prisma.comment.delete({ where: { "id": input["id"] } });
    } catch (error) {
      throw wrapPrismaError(error);
    }
  },
});
