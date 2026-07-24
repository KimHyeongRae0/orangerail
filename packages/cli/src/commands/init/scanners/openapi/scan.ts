import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { IrAction, IrActionField, IrScalar, ScannedSource } from '../../ir';
import { emptySource } from '../../ir';
import { sanitizeMcpName } from '../../codegen/escape';
import type { Scanner } from '../types';
import type { ResolveReason } from './resolve';
import { refOf, resolveLocalRef } from './resolve';

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

/** A request-body schema, possibly a `$ref` or a composed (`allOf`/`oneOf`/`anyOf`) node. */
interface JsonBodySchema {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  $ref?: string;
  allOf?: unknown[];
  oneOf?: unknown[];
  anyOf?: unknown[];
}

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: JsonProperty;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  parameters?: unknown[];
  requestBody?: {
    content?: Record<string, { schema?: JsonBodySchema }>;
  };
}

/** Callback surface a scan uses to aggregate honest resolution diagnostics. */
interface ResolutionSink {
  onUnresolvable: ({ reason }: { reason: ResolveReason }) => void;
  onComposition: () => void;
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

/**
 * Resolve a schema node that may be a local `{ $ref }` into a concrete schema.
 * Returns `undefined` (after reporting the reason) when the reference is
 * unresolvable, so callers skip the field/body rather than crash.
 */
const resolveSchemaNode = ({
  doc,
  node,
  sink,
}: {
  doc: unknown;
  node: unknown;
  sink: ResolutionSink;
}): JsonBodySchema | undefined => {
  const ref = refOf({ value: node });
  if (ref === undefined) {
    return node as JsonBodySchema;
  }

  const result = resolveLocalRef({ doc, ref });

  if (!result.ok) {
    sink.onUnresolvable({ reason: result.reason });
    return undefined;
  }

  return result.value as JsonBodySchema;
};

/**
 * Map a resolved object schema's `properties` into action input fields,
 * resolving any property-level `$ref` before mapping. `forceOptional` makes
 * every field optional (used for `oneOf`/`anyOf` union bodies, where no single
 * branch's requirements bind). A property whose `$ref` is unresolvable is kept
 * as an untyped field — present, never silently dropped — and counted.
 */
const mapObjectProperties = ({
  doc,
  schema,
  sink,
  forceOptional = false,
}: {
  doc: unknown;
  schema: JsonBodySchema;
  sink: ResolutionSink;
  forceOptional?: boolean;
}): IrActionField[] => {
  const fields: IrActionField[] = [];
  const requiredSet = new Set(schema.required ?? []);

  for (const [name, rawProperty] of Object.entries(schema.properties ?? {})) {
    const required = !forceOptional && requiredSet.has(name);
    const ref = refOf({ value: rawProperty });

    if (ref !== undefined) {
      const result = resolveLocalRef({ doc, ref });

      if (!result.ok) {
        sink.onUnresolvable({ reason: result.reason });
        fields.push(mapProperty({ name, property: {}, required }));
        continue;
      }

      fields.push(mapProperty({ name, property: result.value as JsonProperty, required }));
      continue;
    }

    fields.push(mapProperty({ name, property: rawProperty as JsonProperty, required }));
  }

  return fields;
};

/** Merge `allOf` branches: union of branch properties + union of required (branch order). */
const mergeAllOf = ({
  doc,
  branches,
  sink,
}: {
  doc: unknown;
  branches: unknown[];
  sink: ResolutionSink;
}): IrActionField[] => {
  const fields: IrActionField[] = [];
  const seen = new Set<string>();

  for (const branch of branches) {
    const resolved = resolveSchemaNode({ doc, node: branch, sink });

    if (resolved === undefined) {
      continue;
    }

    for (const field of mapObjectProperties({ doc, schema: resolved, sink })) {
      if (seen.has(field.name)) {
        continue;
      }

      seen.add(field.name);
      fields.push(field);
    }
  }

  return fields;
};

/**
 * Map a `oneOf`/`anyOf` union body. A single branch behaves as the plain
 * branch schema (no composition warning); a genuine union surfaces every
 * branch field as OPTIONAL and raises one per-document composition warning
 * (the IR cannot express typed unions — plan §4).
 */
const mergeUnion = ({
  doc,
  branches,
  sink,
}: {
  doc: unknown;
  branches: unknown[];
  sink: ResolutionSink;
}): IrActionField[] => {
  const [only] = branches;

  if (branches.length <= 1) {
    if (only === undefined) {
      return [];
    }

    const resolved = resolveSchemaNode({ doc, node: only, sink });

    return resolved === undefined ? [] : mapObjectProperties({ doc, schema: resolved, sink });
  }

  sink.onComposition();

  const fields: IrActionField[] = [];
  const seen = new Set<string>();

  for (const branch of branches) {
    const resolved = resolveSchemaNode({ doc, node: branch, sink });

    if (resolved === undefined) {
      continue;
    }

    for (const field of mapObjectProperties({ doc, schema: resolved, sink, forceOptional: true })) {
      if (seen.has(field.name)) {
        continue;
      }

      seen.add(field.name);
      fields.push(field);
    }
  }

  return fields;
};

/** Resolve a request body (top-level `$ref`, composition, or inline) into input fields. */
const collectBodyFields = ({
  doc,
  schema,
  sink,
}: {
  doc: unknown;
  schema: JsonBodySchema;
  sink: ResolutionSink;
}): IrActionField[] => {
  const resolved = resolveSchemaNode({ doc, node: schema, sink });

  if (resolved === undefined) {
    return [];
  }

  if (Array.isArray(resolved.allOf)) {
    return mergeAllOf({ doc, branches: resolved.allOf, sink });
  }

  const union = resolved.oneOf ?? resolved.anyOf;
  if (Array.isArray(union)) {
    return mergeUnion({ doc, branches: union, sink });
  }

  return mapObjectProperties({ doc, schema: resolved, sink });
};

const collectInput = ({
  doc,
  operation,
  sink,
}: {
  doc: unknown;
  operation: OpenApiOperation;
  sink: ResolutionSink;
}): IrActionField[] => {
  const fields: IrActionField[] = [];

  for (const rawParam of operation.parameters ?? []) {
    let param: OpenApiParameter;
    const ref = refOf({ value: rawParam });

    if (ref !== undefined) {
      const result = resolveLocalRef({ doc, ref });

      if (!result.ok) {
        // A `{"$ref": …}` parameter whose target is unresolvable is dropped
        // and counted — the skip-with-warning principle keeps it honest.
        sink.onUnresolvable({ reason: result.reason });
        continue;
      }

      param = result.value as OpenApiParameter;
    } else {
      param = rawParam as OpenApiParameter;
    }

    if (param.name === undefined) {
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
    fields.push(...collectBodyFields({ doc, schema: jsonBody, sink }));
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

  const unresolvable: Record<ResolveReason, number> = {
    external: 0,
    missing: 0,
    cycle: 0,
    depth: 0,
  };
  let compositionOps = 0;

  const sink: ResolutionSink = {
    onUnresolvable: ({ reason }) => {
      unresolvable[reason] += 1;
    },
    onComposition: () => {
      compositionOps += 1;
    },
  };

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
        source: 'openapi',
        ...(rawName === undefined || rawName === name ? {} : { rawName }),
        method: method.toUpperCase(),
        path,
        write: true,
        input: collectInput({ doc, operation, sink }),
        ...(operation.summary === undefined ? {} : { description: operation.summary }),
      };

      scanned.actions.push(action);
    }
  }

  const reasons: ResolveReason[] = ['external', 'missing', 'cycle', 'depth'];
  const unresolvableTotal = reasons.reduce((sum, reason) => sum + unresolvable[reason], 0);

  if (unresolvableTotal > 0) {
    const breakdown = reasons
      .filter((reason) => unresolvable[reason] > 0)
      .map((reason) => `${reason}: ${unresolvable[reason]}`)
      .join(', ');

    scanned.warnings.push(
      `openapi: skipped ${unresolvableTotal} unresolvable $ref(s) (${breakdown}) — local #/ component references only; add the missing fields to the generated inputs by hand if the actions need them`,
    );
  }

  if (compositionOps > 0) {
    scanned.warnings.push(
      `openapi: ${compositionOps} composed request body(ies) (oneOf/anyOf) surfaced as an all-optional union — the IR cannot express typed unions; review the generated inputs`,
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
