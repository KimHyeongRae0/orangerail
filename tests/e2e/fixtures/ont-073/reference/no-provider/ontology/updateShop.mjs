/**
 * Orangerail action `updateShop` (Prisma update on model `Shop`).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: runs `prisma.shop.update(...)` against your database whenever the agent calls it.
 * NOT approval-gated: add `policy: { approval: 'required' },` below to stage the call for a human instead.
 */
import { z } from 'zod';

import { registry } from './_registry.mjs';
import { Shop } from './Shop.mjs';

const getPrisma = (() => {
  let client;
  return async () => {
    if (client === undefined) {
      const url = process.env.DATABASE_URL;
      if (url === undefined || url === '') {
        throw new Error("orangerail: DATABASE_URL is not set. Prisma 7 builds its client from a driver adapter, and @prisma/adapter-pg needs a connection URL. Set DATABASE_URL in this process's environment.");
      }
      const { PrismaClient } = await import('@prisma/client');
      const { PrismaPg } = await import("@prisma/adapter-pg");
      client = new PrismaClient({ adapter: new PrismaPg(url) });
    }
    return client;
  };
})();

const DIAGNOSTIC_KEY = Symbol.for('orangerail.publicDiagnostic');

const tagDiagnostic = (error, code, subject) => {
  if (error !== null && typeof error === 'object') {
    Object.defineProperty(error, DIAGNOSTIC_KEY, {
      value: subject === undefined ? { code } : { code, subject },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
};

const wrapPrismaError = (error) => {
  const code = error === null || error === undefined ? undefined : error.code;
  const missing = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
  if (!missing && !(error instanceof TypeError)) {
    return error && error.name === 'PrismaClientInitializationError'
      ? tagDiagnostic(error, 'datasource_not_configured')
      : error;
  }

  const original = error && typeof error.message === 'string' ? error.message : '';
  const detail = original === '' ? '' : ' Original error: ' + original;
  return tagDiagnostic(
    new Error((missing ? "Cannot resolve @prisma/client or @prisma/adapter-pg for object \"Shop\": the Prisma client or its driver adapter is not generated or installed. Fix: run `npm install @prisma/client @prisma/adapter-pg && npx prisma generate`." : "The Prisma client exposes no \"shop\" model for object \"Shop\": the installed client was generated from a different schema. Fix: confirm the model still exists in your Prisma schema, then re-run `npx prisma generate`.") + detail),
    missing ? 'datasource_client_missing' : 'datasource_model_missing',
    "Shop",
  );
};

export const updateShop = registry.defineAction({
  name: "updateShop",
  input: z.object({
    "id": z.number().int(),
    "slug": z.string().optional(),
    "name": z.string().optional(),
  }),
  target: Shop,
  targetIdFrom: "id",
  execute: async ({ input }) => {
    try {
      const prisma = await getPrisma();
      return await prisma.shop.update({
        where: { "id": input["id"] },
        data: {
          "slug": input["slug"],
          "name": input["name"],
        },
      });
    } catch (error) {
      throw wrapPrismaError(error);
    }
  },
});
