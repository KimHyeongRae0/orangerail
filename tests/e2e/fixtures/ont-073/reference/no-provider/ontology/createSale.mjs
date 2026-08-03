/**
 * Orangerail action `createSale` (Prisma create on model `Sale`).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: runs `prisma.sale.create(...)` against your database whenever the agent calls it.
 * NOT approval-gated: add `policy: { approval: 'required' },` below to stage the call for a human instead.
 */
import { z } from 'zod';

import { registry } from './_registry.mjs';

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
    new Error((missing ? "Cannot resolve @prisma/client or @prisma/adapter-pg for object \"Sale\": the Prisma client or its driver adapter is not generated or installed. Fix: run `npm install @prisma/client @prisma/adapter-pg && npx prisma generate`." : "The Prisma client exposes no \"sale\" model for object \"Sale\": the installed client was generated from a different schema. Fix: confirm the model still exists in your Prisma schema, then re-run `npx prisma generate`.") + detail),
    missing ? 'datasource_client_missing' : 'datasource_model_missing',
    "Sale",
  );
};

export const createSale = registry.defineAction({
  name: "createSale",
  op: "create",
  input: z.object({
    "id": z.number().int().optional(),
    "shopId": z.number().int(),
    "reference": z.string(),
    "totalCents": z.number().int(),
    "note": z.string().optional(),
  }),
  execute: async ({ input }) => {
    try {
      const prisma = await getPrisma();
      return await prisma.sale.create({
        data: {
          "id": input["id"],
          "shopId": input["shopId"],
          "reference": input["reference"],
          "totalCents": input["totalCents"],
          "note": input["note"],
        },
      });
    } catch (error) {
      throw wrapPrismaError(error);
    }
  },
});
