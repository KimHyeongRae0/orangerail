import type { LinkDefinition, ObjectDefinition } from '../types';

/** Input to {@link buildLinkDefinition} / `defineLink` (§3.1 / AC-2). */
export interface DefineLinkInput<Name extends string> {
  name: Name;
  from: ObjectDefinition;
  to: ObjectDefinition;
  cardinality: 'one' | 'many';
}

/** Build a typed link definition between two registered object types. */
export const buildLinkDefinition = <Name extends string>(
  def: DefineLinkInput<Name>,
): LinkDefinition<Name> => ({
  kind: 'link',
  name: def.name,
  from: def.from,
  to: def.to,
  cardinality: def.cardinality,
});
