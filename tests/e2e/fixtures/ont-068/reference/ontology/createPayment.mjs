/**
 * Orangerail action `createPayment` (Prisma create on model `Payment`).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 * Write operation: runs `prisma.payment.create(...)` against your database whenever the agent calls it.
 * NOT approval-gated: add `policy: { approval: 'required' },` below to stage the call for a human instead.
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
    new Error((missing ? "Cannot resolve @prisma/client for object \"Payment\": the Prisma client is not generated or installed. Fix: run `npm install @prisma/client && npx prisma generate`, and make sure DATABASE_URL is set." : "The Prisma client exposes no \"payment\" model for object \"Payment\": the installed client was generated from a different schema. Fix: confirm the model still exists in your Prisma schema, then re-run `npx prisma generate`.") + detail),
    missing ? 'datasource_client_missing' : 'datasource_model_missing',
    "Payment",
  );
};

export const createPayment = registry.defineAction({
  name: "createPayment",
  input: z.object({
    "id": z.number().int().optional(),
    "customerId": z.number().int(),
    "amountCents": z.number().int(),
  }),
  execute: async ({ input }) => {
    try {
      const prisma = await getPrisma();
      return await prisma.payment.create({
        data: {
          "id": input["id"],
          "customerId": input["customerId"],
          "amountCents": input["amountCents"],
        },
      });
    } catch (error) {
      throw wrapPrismaError(error);
    }
  },
});
