/**
 * Orangerail object `Sale` (Prisma model Sale).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 */
import { z } from 'zod';

import { registry } from './_registry.mjs';

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

export const Sale = registry.defineObject({
  name: "Sale",
  schema: z.object({
    "id": z.number().int(),
    "shopId": z.number().int(),
    "reference": z.string(),
    "totalCents": z.number().int(),
    "note": z.string().optional(),
  }),
  resolve: {
    get: async ({ id }) => {
      try {
        const prisma = await getPrisma();
        const key = Number(id);
        if (Number.isNaN(key)) {
          return null;
        }
        return await prisma.sale.findUnique({ where: { "id": key } });
      } catch (error) {
        throw wrapPrismaError(error);
      }
    },
    list: async ({ filter, cursor, limit } = {}) => {
      try {
        const prisma = await getPrisma();
        const take = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50;
        const rows = await prisma.sale.findMany({
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
