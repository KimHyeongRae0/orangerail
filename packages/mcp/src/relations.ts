import type { LinkDefinition } from 'orangerail-core';

/**
 * Turn the registry's links into one sentence per object, for the read tools'
 * descriptions.
 *
 * The registry has always held this (`registry.listLinks()`, populated from
 * `defineLink` — which `orangerail init` emits one of per Prisma relation into
 * `ontology/_links.mjs`) and the MCP server has never read it, so an agent
 * handed `Customer_list` and `Order_list` had nothing telling it the two were
 * connected at all. The studio draws these edges; the agent could not see them.
 *
 * This adds KNOWLEDGE and nothing else. The generated read surface is still
 * `<Object>_get` plus a filtered, paginated `<Object>_list` — there is no join,
 * no aggregate and no traversal tool here, and the sentence is written so it
 * never suggests one: it states a fact about the domain, in no imperative mood.
 */

/**
 * The phrase each side of a link contributes to its own object's sentence.
 *
 * A `many` link is a parent -> child edge (`Customer` has many `Order`), which
 * is exactly the one `deriveLinks` emits per Prisma relation pair, so the child
 * side reads `belongs to`. A `one` link is a single reference, so the far side
 * gets the weaker `referenced by` — claiming ownership there would be an
 * inference the declaration does not support.
 */
const phrasesFor = ({ link }: { link: LinkDefinition }): { from: string; to: string } =>
  link.cardinality === 'many'
    ? { from: `has many ${link.to.name}`, to: `belongs to ${link.from.name}` }
    : { from: `has one ${link.to.name}`, to: `referenced by ${link.from.name}` };

/**
 * `object name -> relation sentence`, e.g. `Relations: has many Order.`
 *
 * Links are sorted by name before anything is accumulated, and duplicate
 * phrases are dropped in that order, so the sentence is a function of the
 * registry's contents and not of the order `defineLink` happened to run in.
 * Two links between the same pair — a Prisma model with `author` and
 * `reviewer` both pointing at `User` — collapse to one phrase; there is no
 * relation-field name in a `LinkDefinition` to tell them apart with, and
 * inventing one would be a claim about a foreign key nobody recorded.
 *
 * An object with no links gets no entry, so its description is byte-identical
 * to the one it had before.
 */
export const relationLines = ({
  links,
}: {
  links: readonly LinkDefinition[];
}): Map<string, string> => {
  const phrases = new Map<string, string[]>();

  const add = ({ object, phrase }: { object: string; phrase: string }): void => {
    const existing = phrases.get(object);

    if (existing === undefined) {
      phrases.set(object, [phrase]);
      return;
    }

    if (!existing.includes(phrase)) {
      existing.push(phrase);
    }
  };

  for (const link of [...links].sort((a, b) => a.name.localeCompare(b.name))) {
    const phrase = phrasesFor({ link });

    add({ object: link.from.name, phrase: phrase.from });
    add({ object: link.to.name, phrase: phrase.to });
  }

  return new Map([...phrases].map(([object, list]) => [object, `Relations: ${list.join('; ')}.`]));
};
