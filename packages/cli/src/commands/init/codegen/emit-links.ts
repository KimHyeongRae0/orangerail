import type { IrObject } from '../ir';
import { ownershipLine } from './emit-object';
import { escapeStringLiteral, sanitizeIdentifier, sanitizeMcpName } from './escape';

/** A derived link between two objects (one per relation pair). */
export interface DerivedLink {
  name: string;
  from: string;
  to: string;
  cardinality: 'one' | 'many';
}

/**
 * Derive one link per relation pair (plan D2/AC-1). A Prisma relation is
 * bidirectional: the `Model[]` side is the "many" side and the `@relation`
 * owner side is the "one" side. Emitting a link only for the `many` side yields
 * exactly one `defineLink` per pair (parent -> child, cardinality `many`),
 * deterministically ordered by link name.
 */
export const deriveLinks = ({ objects }: { objects: IrObject[] }): DerivedLink[] => {
  const objectNames = new Set(objects.map((o) => o.name));
  const links: DerivedLink[] = [];

  for (const object of objects) {
    for (const relation of object.relations) {
      if (relation.cardinality !== 'many' || !objectNames.has(relation.target)) {
        continue;
      }

      links.push({
        name: sanitizeMcpName({ value: `${object.name}_${relation.field}` }),
        from: object.name,
        to: relation.target,
        cardinality: 'many',
      });
    }
  }

  return links.sort((a, b) => a.name.localeCompare(b.name));
};

/** Render `ontology/_links.mjs` for the derived links (or `undefined` if none). */
export const emitLinksFile = ({
  links,
}: {
  links: DerivedLink[];
}): { filename: string; content: string } | undefined => {
  if (links.length === 0) {
    return undefined;
  }

  const imported = [...new Set(links.flatMap((l) => [l.from, l.to]))].sort();

  const header = [
    '/**',
    ' * Orangerail links (generated from Prisma relations).',
    ' *',
    ` * ${ownershipLine}`,
    ' */',
  ].join('\n');

  const importLines = [
    "import { registry } from './_registry.mjs';",
    ...imported.map((name) => {
      const binding = sanitizeIdentifier({ value: name });

      return `import { ${binding} } from './${binding}.mjs';`;
    }),
  ];

  const linkLines = links.map((link) => {
    const from = sanitizeIdentifier({ value: link.from });
    const to = sanitizeIdentifier({ value: link.to });

    return `registry.defineLink({ name: ${escapeStringLiteral({ value: link.name })}, from: ${from}, to: ${to}, cardinality: ${escapeStringLiteral({ value: link.cardinality })} });`;
  });

  const body = [...importLines, '', ...linkLines, ''].join('\n');

  return { filename: '_links.mjs', content: `${header}\n${body}` };
};
