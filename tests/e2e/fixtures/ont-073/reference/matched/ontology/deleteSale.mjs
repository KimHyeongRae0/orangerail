/**
 * Orangerail action `deleteSale` (Prisma delete on model `Sale`).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: staged for human approval; on approval it runs `prisma.sale.delete(...)` against your database.
 * DESTRUCTIVE: permanently deletes a `Sale` row on approval — an approver should confirm the identifier before authorizing.
 */
import { z } from 'zod';

import { registry } from './_registry.mjs';
import { Sale } from './Sale.mjs';

const getPrisma = (() => {
  let client;
  return async () => {
    if (client === undefined) {
      const url = process.env.DATABASE_URL;
      if (url === undefined || url === '') {
        throw new Error("orangerail: DATABASE_URL is not set. Prisma 7 builds its client from a driver adapter, and @prisma/adapter-mariadb needs a connection URL. Set DATABASE_URL in this process's environment.");
      }
      const { PrismaClient } = await import('@prisma/client');
      const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
      client = new PrismaClient({ adapter: new PrismaMariaDb(url) });
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
    new Error((missing ? "Cannot resolve @prisma/client or @prisma/adapter-mariadb for object \"Sale\": the Prisma client or its driver adapter is not generated or installed. Fix: run `npm install @prisma/client @prisma/adapter-mariadb && npx prisma generate`." : "The Prisma client exposes no \"sale\" model for object \"Sale\": the installed client was generated from a different schema. Fix: confirm the model still exists in your Prisma schema, then re-run `npx prisma generate`.") + detail),
    missing ? 'datasource_client_missing' : 'datasource_model_missing',
    "Sale",
  );
};

export const deleteSale = registry.defineAction({
  name: "deleteSale",
  input: z.object({
    "id": z.number().int(),
  }),
  policy: { approval: 'required' },
  target: Sale,
  targetIdFrom: "id",
  execute: async ({ input }) => {
    try {
      const prisma = await getPrisma();
      return await prisma.sale.delete({ where: { "id": input["id"] } });
    } catch (error) {
      throw wrapPrismaError(error);
    }
  },
});
