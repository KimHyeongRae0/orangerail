import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Scanner } from '../types';
import { mapPrismaToIr } from './map';
import { parsePrismaSchema } from './parse';

/** Conventional Prisma schema locations, in detection order. */
const CANDIDATES = ['prisma/schema.prisma', 'schema.prisma'];

/**
 * The Prisma scanner (plan D3). `detect` looks for a schema at the conventional
 * paths; `scan` reads, parses, and maps it into the shared IR. It only ever
 * reads the schema file (never the generated client), so init succeeds even
 * when `@prisma/client` is absent — a missing client surfaces later as a
 * tool-call-time error from the generated lazy import (D6).
 */
export const prismaScanner: Scanner = {
  name: 'prisma',

  detect: ({ cwd }) => CANDIDATES.map((rel) => join(cwd, rel)).filter((abs) => existsSync(abs)),

  scan: ({ filePath }) => {
    const source = readFileSync(filePath, 'utf8');
    const parsed = parsePrismaSchema({ source });

    return mapPrismaToIr({ parsed });
  },
};
