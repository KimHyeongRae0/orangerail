import { createHash } from 'node:crypto';

import type { z } from 'zod';

import { canonicalJson, inputShape } from './introspect';
import type { RuntimePolicy, WhereClause } from './types';

/**
 * Reduce a `where` clause to its hashable form. A functional predicate
 * contributes the constant `"functional"` — its body is opaque to the hash,
 * which is exactly why the execute wrapper re-parses the input against the
 * current schema (§3.4 step 3) rather than trusting the hash alone.
 */
const whereSignature = ({ where }: { where?: WhereClause | undefined }): unknown => {
  if (where === undefined) {
    return null;
  }

  if (typeof where === 'function') {
    return 'functional';
  }

  return { field: where.field, op: where.op, value: where.value };
};

const policyDeclarative = ({ policy }: { policy?: RuntimePolicy | undefined }): unknown => ({
  approval: policy?.approval ?? null,
  roles: [...(policy?.roles ?? [])].sort(),
  where: whereSignature({ where: policy?.where }),
});

/**
 * Compute the action signature hash: sha256 (node:crypto — no new dependency)
 * over canonical JSON of `{ actionName, inputShape, policyDeclarative }`
 * (§3.4). It is the fast detector for action-deleted / renamed / declared-shape
 * drift between staging and execution.
 */
export const computeSignatureHash = ({
  actionName,
  input,
  policy,
}: {
  actionName: string;
  input: z.ZodType;
  policy?: RuntimePolicy | undefined;
}): string => {
  const canonical = canonicalJson({
    value: {
      actionName,
      inputShape: inputShape({ schema: input }),
      policyDeclarative: policyDeclarative({ policy }),
    },
  });

  return createHash('sha256').update(canonical).digest('hex');
};
