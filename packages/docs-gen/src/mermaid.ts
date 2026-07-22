import { getShape, isOptionalField, type Registry } from 'orangerail-core';

import { createIdAllocator, escapeMermaidLabel } from './escape';
import { fieldTypeName } from './field';

/**
 * Emit a Mermaid `classDiagram` for an ontology registry (plan §3.2). The
 * diagram is the only Mermaid type that hosts all three concept kinds:
 *
 * - object type → `class id["name"]` with top-level fields as typed members
 *   (optional fields suffixed `?` via `isOptionalField`);
 * - link type → association `from "1" --> "card" to : linkName`;
 * - action type → `class id["name"]` carrying the `<<action>>` stereotype, plus
 *   a dashed dependency `action ..> target : approval|auto` when a target
 *   exists; a target-less action is a standalone stereotyped node.
 *
 * Node IDs are sanitized to `[A-Za-z0-9_]` with deterministic collision
 * suffixes; display names ride only inside escaped quoted labels, so a hostile
 * name never leaks into diagram structure (AC-7). Output is byte-deterministic:
 * objects then actions, each alphabetical by name (AC-6).
 */
export const generateMermaid = ({ registry }: { registry: Registry }): string => {
  const alloc = createIdAllocator();

  const objects = [...registry.listObjects()].sort((a, b) => a.name.localeCompare(b.name));
  const actions = [...registry.listActions()].sort((a, b) => a.name.localeCompare(b.name));
  const links = [...registry.listLinks()].sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = ['classDiagram'];

  const objectId = new Map<string, string>();

  for (const object of objects) {
    const id = alloc.allocate({ name: object.name });
    objectId.set(object.name, id);

    const label = escapeMermaidLabel({ value: object.name });
    const shape = getShape({ schema: object.schema });
    const fieldNames = Object.keys(shape).sort();

    if (fieldNames.length === 0) {
      lines.push(`class ${id}["${label}"]`);
      continue;
    }

    lines.push(`class ${id}["${label}"] {`);

    for (const fieldName of fieldNames) {
      const node = shape[fieldName];
      const optional = isOptionalField({ node }) ? '?' : '';

      // Field names are user-supplied too — a raw `}` or `"` in a member line
      // would break the class block (AC-7 applies to members, not just labels).
      lines.push(
        `  ${escapeMermaidLabel({ value: fieldName })}${optional}: ${fieldTypeName({ node })}`,
      );
    }

    lines.push('}');
  }

  for (const action of actions) {
    const id = alloc.allocate({ name: action.name });
    const label = escapeMermaidLabel({ value: action.name });

    lines.push(`class ${id}["${label}"] {`);
    lines.push('  <<action>>');
    lines.push('}');
  }

  for (const link of links) {
    const fromId = objectId.get(link.from.name);
    const toId = objectId.get(link.to.name);

    if (fromId === undefined || toId === undefined) {
      continue;
    }

    const toCard = link.cardinality === 'many' ? 'many' : '1';
    const label = escapeMermaidLabel({ value: link.name });
    lines.push(`${fromId} "1" --> "${toCard}" ${toId} : ${label}`);
  }

  for (const action of actions) {
    if (!action.target) {
      continue;
    }

    const fromId = alloc.allocate({ name: action.name });
    const toId = objectId.get(action.target.name);

    if (toId === undefined) {
      continue;
    }

    const marker = action.policy?.approval === 'required' ? 'approval' : 'auto';
    lines.push(`${fromId} ..> ${toId} : ${marker}`);
  }

  // A classDiagram with no body does not parse; a note keeps an empty ontology's
  // diagram valid and coherent (ticket edge case: zero objects / zero actions).
  if (lines.length === 1) {
    lines.push('note "No object or action types are declared."');
  }

  return lines.join('\n');
};
