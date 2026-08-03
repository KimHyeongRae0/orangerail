/**
 * Orangerail action `deleteOrderItem` (Prisma delete on model `OrderItem`).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: staged for human approval; on approval it runs `prisma.orderItem.delete(...)` against your database.
 * DESTRUCTIVE: permanently deletes a `OrderItem` row on approval — an approver should confirm the identifier before authorizing.
 */
import { z } from 'zod';

import { registry } from './_registry.mjs';
import { OrderItem } from './OrderItem.mjs';

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
    new Error((missing ? "Cannot resolve @prisma/client for object \"OrderItem\": the Prisma client is not generated or installed. Fix: run `npm install @prisma/client && npx prisma generate`, and make sure DATABASE_URL is set." : "The Prisma client exposes no \"orderItem\" model for object \"OrderItem\": the installed client was generated from a different schema. Fix: confirm the model still exists in your Prisma schema, then re-run `npx prisma generate`.") + detail),
    missing ? 'datasource_client_missing' : 'datasource_model_missing',
    "OrderItem",
  );
};

export const deleteOrderItem = registry.defineAction({
  name: "deleteOrderItem",
  op: "delete",
  input: z.object({
    "id": z.string(),
  }),
  policy: { approval: 'required' },
  target: OrderItem,
  targetIdFrom: "id",
  execute: async ({ input }) => {
    try {
      const prisma = await getPrisma();
      return await prisma.orderItem.delete({ where: { "id": input["id"] } });
    } catch (error) {
      throw wrapPrismaError(error);
    }
  },
});
