import type { McpPreset } from 'orangerail-mcp';

import type { ScannedSource } from '../ir';
import { emitActionFile, type GatePolicy } from './emit-action';
import { emitConfigFile, emitRegistryFile } from './emit-config';
import { deriveLinks, emitLinksFile } from './emit-links';
import { emitObjectFile } from './emit-object';
import { BARE_CONSTRUCTION, type PrismaConstruction } from './prisma-runtime';

/** A single generated file, path relative to the target repo root. */
export interface GeneratedFile {
  path: string;
  content: string;
}

export { DEFAULT_GATE, GATE_POLICIES, isActionGated, type GatePolicy } from './emit-action';
export { deriveLinks } from './emit-links';
export { emitObjectFile } from './emit-object';
export * from './prisma-runtime';

/**
 * Assemble the full byte-deterministic file set from a merged scanned source
 * (plan D5/D9). Ordering is stable — objects and actions sorted by name, the
 * shared registry and links under `ontology/` with underscore-prefixed names —
 * and nothing carries a timestamp, so the same inputs render the same bytes
 * twice (AC-9).
 *
 * Filename/binding uniqueness across objects + actions is guaranteed UPSTREAM by
 * the global allocator in `scanRepo` (ONT-015, `init/scan.ts` `allocateNames`),
 * so this stays a pure renderer over an already-collision-free source — no
 * de-collision logic lives here.
 */
export const buildFileSet = ({
  source,
  preset,
  gate,
  construction = BARE_CONSTRUCTION,
}: {
  source: ScannedSource;
  preset: McpPreset;
  /**
   * Which generated actions declare `policy: { approval: 'required' }`
   * (ONT-056). Required, with no default — see `emitActionFile`.
   */
  gate: GatePolicy;
  /**
   * How the generated Prisma call sites construct their client (ONT-049).
   * Defaults to the pre-7 bare constructor, so every caller that does not care
   * about the target repo's Prisma major renders exactly the bytes it always
   * rendered.
   */
  construction?: PrismaConstruction;
}): GeneratedFile[] => {
  const files: GeneratedFile[] = [];

  const config = emitConfigFile({ preset });
  files.push({ path: config.filename, content: config.content });

  const registry = emitRegistryFile();
  files.push({ path: `ontology/${registry.filename}`, content: registry.content });

  const links = deriveLinks({ objects: source.objects });
  const linksFile = emitLinksFile({ links });
  if (linksFile !== undefined) {
    files.push({ path: `ontology/${linksFile.filename}`, content: linksFile.content });
  }

  const objects = [...source.objects].sort((a, b) => a.name.localeCompare(b.name));
  for (const object of objects) {
    const file = emitObjectFile({ object, construction });
    files.push({ path: `ontology/${file.filename}`, content: file.content });
  }

  const actions = [...source.actions].sort((a, b) => a.name.localeCompare(b.name));
  for (const action of actions) {
    const file = emitActionFile({ action, gate, construction });
    files.push({ path: `ontology/${file.filename}`, content: file.content });
  }

  return files;
};
