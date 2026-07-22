import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { IrAction, IrActionField, IrScalar, ScannedSource } from '../../ir';
import { emptySource } from '../../ir';
import { sanitizeMcpName } from '../../codegen/escape';
import type { Scanner } from '../types';

/**
 * OpenAPI 3.x JSON scanner (plan D4). v0 accepts a JSON document only: a YAML
 * spec (detected by filename) yields a clear, actionable convert-to-JSON
 * diagnostic instead of silent absence, because a hand-rolled YAML parser is a
 * correctness/security trap and a `yaml` dependency breaks the CLI's
 * zero-runtime-deps line. GET operations are skipped with an info line (reads
 * belong to objects/resolve); every non-GET operation becomes a write action.
 */

const JSON_TYPE_TO_SCALAR: Record<string, IrScalar> = {
  string: 'string',
  integer: 'int',
  number: 'float',
  boolean: 'boolean',
};

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const YAML_CANDIDATES = ['openapi.yaml', 'openapi.yml', 'swagger.yaml', 'swagger.yml'];

/** Diagnostic emitted when only a YAML spec is present (plan D4). */
export const YAML_HINT =
  "OpenAPI YAML detected but v0 accepts JSON only — convert it to JSON (`npx yaml2json <file>` or your generator's JSON output) and re-run. YAML input is planned, not in v0.";

interface JsonProperty {
  type?: string;
  enum?: unknown[];
}

interface JsonBodySchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonProperty>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  parameters?: { name?: string; in?: string; required?: boolean; schema?: JsonProperty }[];
  requestBody?: {
    content?: Record<string, { schema?: JsonBodySchema }>;
  };
}

/** Whether a `*.json` file is an OpenAPI 3.x document (top-level `openapi`). */
const isOpenApiJson = ({ filePath }: { filePath: string }): boolean => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));

    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { openapi?: unknown }).openapi === 'string'
    );
  } catch {
    return false;
  }
};

/** Derive an action name from method + path when there is no operationId. */
const deriveName = ({ method, path }: { method: string; path: string }): string => {
  const segments = path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.replace(/[{}]/g, ''))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));

  return sanitizeMcpName({ value: `${method}${segments.join('')}` });
};

const mapProperty = ({
  name,
  property,
  required,
}: {
  name: string;
  property: JsonProperty;
  required: boolean;
}): IrActionField => {
  if (Array.isArray(property.enum)) {
    return {
      name,
      kind: 'enum',
      enumValues: property.enum.map((v) => String(v)),
      optional: !required,
    };
  }

  const scalar = property.type === undefined ? undefined : JSON_TYPE_TO_SCALAR[property.type];

  return {
    name,
    kind: 'scalar',
    ...(scalar === undefined ? {} : { scalar }),
    optional: !required,
  };
};

const collectInput = ({
  operation,
  onRefParam,
}: {
  operation: OpenApiOperation;
  onRefParam: () => void;
}): IrActionField[] => {
  const fields: IrActionField[] = [];

  for (const param of operation.parameters ?? []) {
    if (param.name === undefined) {
      // A `{"$ref": "#/components/parameters/…"}` entry — component
      // resolution is not in v0, and dropping a field silently would break
      // the skip-with-warning principle, so the caller aggregates a count.
      onRefParam();
      continue;
    }

    if (param.in !== 'path') {
      continue;
    }

    fields.push(
      mapProperty({
        name: param.name,
        property: param.schema ?? {},
        required: param.required === true,
      }),
    );
  }

  const jsonBody = operation.requestBody?.content?.['application/json']?.schema;
  if (jsonBody !== undefined) {
    const requiredSet = new Set(jsonBody.required ?? []);

    for (const [name, property] of Object.entries(jsonBody.properties ?? {})) {
      fields.push(mapProperty({ name, property, required: requiredSet.has(name) }));
    }
  }

  return fields;
};

/** Parse an OpenAPI JSON document into scanned write actions. */
export const scanOpenApiJson = ({ source }: { source: string }): ScannedSource => {
  const scanned = emptySource();

  let doc: { paths?: Record<string, Record<string, OpenApiOperation>> };
  try {
    doc = JSON.parse(source) as typeof doc;
  } catch (err) {
    scanned.warnings.push(
      `openapi: could not parse JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
    return scanned;
  }

  const paths = doc.paths ?? {};
  let refParamCount = 0;
  const refParamOps = new Set<string>();

  for (const path of Object.keys(paths).sort()) {
    const methods = paths[path] ?? {};

    for (const method of Object.keys(methods).sort()) {
      const operation = methods[method];
      if (operation === undefined) {
        continue;
      }

      if (method.toLowerCase() === 'get') {
        scanned.infos.push(`openapi: skipping GET ${path} — reads are exposed as object resolve`);
        continue;
      }

      if (!WRITE_METHODS.has(method.toLowerCase())) {
        continue;
      }

      const rawName = operation.operationId;
      const name =
        rawName === undefined || rawName.trim() === ''
          ? deriveName({ method: method.toLowerCase(), path })
          : sanitizeMcpName({ value: rawName });

      const action: IrAction = {
        name,
        ...(rawName === undefined || rawName === name ? {} : { rawName }),
        method: method.toUpperCase(),
        path,
        write: true,
        input: collectInput({
          operation,
          onRefParam: () => {
            refParamCount += 1;
            refParamOps.add(`${method.toUpperCase()} ${path}`);
          },
        }),
        ...(operation.summary === undefined ? {} : { description: operation.summary }),
      };

      scanned.actions.push(action);
    }
  }

  if (refParamCount > 0) {
    scanned.warnings.push(
      `openapi: skipped ${refParamCount} $ref parameter(s) across ${refParamOps.size} operation(s) — component parameter resolution is not in v0; add the missing fields to the generated inputs by hand if the actions need them`,
    );
  }

  return scanned;
};

/**
 * The OpenAPI scanner (plan D4). `detect` finds an OpenAPI 3.x JSON document at
 * the repo root (or the first `*.json` that self-identifies via `openapi`);
 * when only a YAML spec exists, it surfaces the convert-to-JSON hint as a
 * warning so a YAML-first user is never told "nothing found".
 */
export const openapiScanner: Scanner = {
  name: 'openapi',

  detect: ({ cwd }) => {
    const preferred = ['openapi.json', 'swagger.json']
      .map((rel) => join(cwd, rel))
      .filter((abs) => existsSync(abs) && isOpenApiJson({ filePath: abs }));

    if (preferred.length > 0) {
      return preferred;
    }

    const jsonHits = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => join(cwd, e.name))
      .filter((abs) => isOpenApiJson({ filePath: abs }))
      .sort();

    return jsonHits;
  },

  scan: ({ filePath }) => scanOpenApiJson({ source: readFileSync(filePath, 'utf8') }),
};

/** Whether a YAML OpenAPI/Swagger spec exists at the repo root (plan D4). */
export const hasYamlSpec = ({ cwd }: { cwd: string }): boolean =>
  YAML_CANDIDATES.some((rel) => existsSync(join(cwd, rel)));
