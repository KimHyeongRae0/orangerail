/**
 * ONT-070 e2e fixture — a target row `JSON.stringify` cannot print.
 *
 * One gated `delete_product` action over a `product` object whose `resolve.get`
 * hands back a live row carrying a cycle (`row.self === row`), a function-valued
 * column, and a symbol-keyed one. Nothing here is a `BigInt`: the crash this
 * ticket fixes must be provable without the `BigInt` contract ONT-068 owns, or
 * neither fix can be told apart from the other.
 *
 * A shape a real datasource produces: an ORM row with a back-reference to its
 * parent, a lazy relation loader hung off the object, an internal marker keyed
 * by symbol. The staged INPUT is `{ "id": "p3" }` and perfectly serializable —
 * the approval stages, lists and rejects fine. Only reading it used to crash.
 *
 * The store directory comes from ORANGERAIL_E2E_STORE so the driver owns the
 * sandbox.
 */
import { createFileStore, createRegistry } from 'orangerail-core';
import { z } from 'zod';

const storeDir = process.env.ORANGERAIL_E2E_STORE;

if (!storeDir) {
  throw new Error('ORANGERAIL_E2E_STORE must be set');
}

const registry = createRegistry();

/** The row a live read returns: verbatim columns first, then the parts JSON refuses. */
const readProduct = ({ id }) => {
  const row = {
    id,
    title: 'Blue Mug',
    stock: 12,
    notes: 'A'.repeat(4096),
  };

  row.self = row;
  row.loadOrders = function loadOrders() {
    return [];
  };
  row[Symbol('internal.rowVersion')] = 7;

  return row;
};

const product = registry.defineObject({
  name: 'product',
  schema: z.object({ id: z.string(), title: z.string(), stock: z.number() }),
  resolve: {
    get: async ({ id }) => readProduct({ id }),
  },
});

registry.defineAction({
  name: 'delete_product',
  target: product,
  targetIdFrom: 'id',
  input: z.object({ id: z.string() }),
  policy: { approval: 'required' },
  execute: async ({ input }) => ({ deleted: input.id }),
});

export default {
  registry,
  store: createFileStore({ dir: storeDir }),
  allowDevMode: true,
};
