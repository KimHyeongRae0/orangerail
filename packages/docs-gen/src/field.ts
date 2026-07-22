import { typeNameOf } from 'orangerail-core';

/**
 * Field-type rendering for docs (§3.4). `typeNameOf` is intentionally shallow,
 * so a wrapped field like `z.number().optional()` reports the wrapper
 * (`optional`) rather than the meaningful inner type. Optionality is rendered
 * separately (a `?` suffix / an "Optional" column via `isOptionalField`), so
 * here we unwrap `optional` / `nullable` / `default` wrappers to the inner type
 * for display. Version-tolerant: the inner node lives at `_def.innerType` (zod
 * v3) or `def.innerType` (zod v4) for all three wrappers.
 */
const WRAPPER_TYPES = new Set(['optional', 'nullable', 'default']);

const innerNode = ({ node }: { node: unknown }): unknown => {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }

  const withDef = node as { _def?: { innerType?: unknown }; def?: { innerType?: unknown } };
  const def = withDef._def ?? withDef.def;

  return def && typeof def === 'object' ? def.innerType : undefined;
};

/** Meaningful display type name of a field node (wrappers unwrapped). */
export const fieldTypeName = ({ node }: { node: unknown }): string => {
  let current = node;

  for (let depth = 0; depth < 8; depth += 1) {
    const name = typeNameOf({ node: current });

    if (!WRAPPER_TYPES.has(name)) {
      return name;
    }

    const inner = innerNode({ node: current });
    if (inner === undefined) {
      return name;
    }

    current = inner;
  }

  return typeNameOf({ node: current });
};
