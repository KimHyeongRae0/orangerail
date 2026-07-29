import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import type {
  IrAction,
  IrActionField,
  IrScalar,
  IrValueConstraints,
  ScannedSource,
} from '../../ir';
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
  /** `type: array` item schema (possibly a `$ref`). */
  items?: unknown;
  /** `type: object` nested properties (possibly each a `$ref`). */
  properties?: Record<string, unknown>;
  required?: string[];
  minimum?: unknown;
  maximum?: unknown;
  /** OpenAPI 3.0 spells this as a boolean modifier on `minimum`; 3.1 as the bound. */
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
  multipleOf?: unknown;
  nullable?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  uniqueItems?: unknown;
  minProperties?: unknown;
  maxProperties?: unknown;
}

/** Numeric value keywords — meaningless on a non-numeric kind. */
const NUMERIC_KEYWORDS = [
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'exclusiveMaximum',
] as const satisfies readonly (keyof JsonProperty)[];

/** String value keywords — meaningless on a non-string kind. */
const STRING_KEYWORDS = [
  'minLength',
  'maxLength',
  'pattern',
] as const satisfies readonly (keyof JsonProperty)[];

/**
 * Keywords that are value constraints the IR does not carry on ANY kind, so they
 * are reported wherever they appear rather than silently dropped. `multipleOf`
 * and the array/object cardinality keywords are all expressible in zod; carrying
 * them is simply outside the honored set, and a warning is the floor (ONT-037).
 * `nullable` is OpenAPI 3.0's null modifier — a type change, not a bound.
 */
const UNHONORED_KEYWORDS = [
  'multipleOf',
  'nullable',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
] as const satisfies readonly (keyof JsonProperty)[];

/**
 * How deep a nested request-body object is rendered before the shape is reported
 * as beyond what the generated input expresses. The `$ref` resolver has its own
 * cycle/depth guard, but a body can also nest through INLINE `properties`, which
 * that guard never sees — this bound is what keeps such a document from
 * recursing without end.
 */
const MAX_NESTING = 5;

/**
 * A field name that a JS object literal cannot carry as a plain key: `__proto__`
 * in `{ "__proto__": v }` sets the prototype instead of creating an own
 * property, so the field would disappear from the emitted zod object, from the
 * action input, and from a Prisma `data:` payload — silently, which is exactly
 * what this scanner's convention forbids (ONT-042 E).
 */
const UNSAFE_KEY = '__proto__';

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
  /** A declared value constraint that the IR cannot express on this field. */
  onDroppedConstraint: ({ field, keyword }: { field: string; keyword: string }) => void;
  /** A declared TYPE shape (array/object) the IR cannot express on this field. */
  onDroppedShape: ({ field, detail }: { field: string; detail: string }) => void;
  /** A composed body re-declared a property a previous branch already claimed. */
  onShadowedProperty: ({ field }: { field: string }) => void;
  /** A request body mapped from a non-JSON media type because no JSON one exists. */
  onNonJsonBody: ({ label, mediaType }: { label: string; mediaType: string }) => void;
  /** A request body whose content declares no `schema` anywhere — no inputs at all. */
  onSkippedBody: ({ label, mediaTypes }: { label: string; mediaTypes: string }) => void;
  /** A field whose name a JS object literal cannot carry as a plain key. */
  onUnsafeKey: ({ field }: { field: string }) => void;
}

/** How a `*.json` file relates to this scanner: a spec, unreadable, or unrelated. */
type JsonKind = 'openapi' | 'unparseable' | 'other';

/**
 * Classify a `*.json` file. A file that does not PARSE is deliberately kept
 * distinct from one that parses into something else: a conventionally named
 * `openapi.json` with a trailing comma is still that user's spec, and reporting
 * it as absent (which a plain boolean forced) told them their spec did not
 * exist — while the scanner's own `could not parse` diagnostic sat unreachable
 * behind the same filter (ONT-042 C).
 */
const classifyJson = ({ filePath }: { filePath: string }): JsonKind => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return 'unparseable';
  }

  return typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { openapi?: unknown }).openapi === 'string'
    ? 'openapi'
    : 'other';
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

/** A finite JSON number, or `undefined` for anything else (`"0"`, `NaN`, null). */
const finiteNumber = ({ value }: { value: unknown }): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** A length keyword's value: a non-negative integer, or `undefined` if malformed. */
const lengthValue = ({ value }: { value: unknown }): number | undefined => {
  const n = finiteNumber({ value });

  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
};

/** A `pattern` that actually compiles, or `undefined` — an uncompilable one would
 * make the generated `ontology/*.mjs` throw at import, so it never gets emitted. */
const compilablePattern = ({ value }: { value: unknown }): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    new RegExp(value);
    return value;
  } catch {
    return undefined;
  }
};

/** Whether a keyword is meaningfully declared (a `false` exclusivity flag is not). */
const isDeclared = ({ value }: { value: unknown }): boolean =>
  value !== undefined && value !== false;

/**
 * Resolve one numeric bound side into its inclusive and/or exclusive value.
 * OpenAPI 3.0 spells exclusivity as a boolean modifier on the inclusive keyword
 * (`{"minimum": 0, "exclusiveMinimum": true}`); JSON Schema 2020-12 / OpenAPI 3.1
 * spells it as the bound itself (`{"exclusiveMinimum": 0}`). Both collapse here,
 * so the emitter renders `.gt(0)` either way. When the 3.1 form declares BOTH,
 * both are returned — their intersection is what the spec means, and emitting
 * only one of them could be weaker than what the author declared.
 */
const resolveBound = ({
  inclusiveRaw,
  exclusiveRaw,
  inclusiveKeyword,
  exclusiveKeyword,
  drop,
}: {
  inclusiveRaw: unknown;
  exclusiveRaw: unknown;
  inclusiveKeyword: string;
  exclusiveKeyword: string;
  drop: ({ keyword }: { keyword: string }) => void;
}): { inclusive?: number; exclusive?: number } => {
  const inclusive = finiteNumber({ value: inclusiveRaw });

  if (inclusiveRaw !== undefined && inclusive === undefined) {
    drop({ keyword: inclusiveKeyword });
  }

  if (!isDeclared({ value: exclusiveRaw })) {
    return inclusive === undefined ? {} : { inclusive };
  }

  if (exclusiveRaw === true) {
    // 3.0 modifier form: the flag binds nothing without a sibling bound.
    if (inclusive === undefined) {
      drop({ keyword: exclusiveKeyword });
      return {};
    }

    return { exclusive: inclusive };
  }

  const exclusive = finiteNumber({ value: exclusiveRaw });

  if (exclusive === undefined) {
    drop({ keyword: exclusiveKeyword });
    return inclusive === undefined ? {} : { inclusive };
  }

  return inclusive === undefined ? { exclusive } : { inclusive, exclusive };
};

/**
 * Which family of value keywords a mapped node can actually honor. An untyped
 * property is `'string'`, not `'none'`: `baseOf` renders it as `z.string()`, so
 * its `pattern` / `minLength` / `maxLength` ARE enforceable and reporting them as
 * dropped would be a lie in the other direction (ONT-042 F). An enum, an object,
 * an array node, a boolean and the `json` fallback honor nothing.
 */
type ConstraintKind = 'numeric' | 'string' | 'none';

/**
 * Read a property's declared value constraints into the IR (ONT-037). Every
 * keyword that is declared but cannot be honored — wrong kind for the keyword, a
 * malformed value, an uncompilable pattern, or one of `UNHONORED_KEYWORDS` — is
 * reported to the sink instead of vanishing, which is the same skip-with-warning
 * discipline the rest of this scanner already follows.
 */
const collectConstraints = ({
  name,
  property,
  honors,
  sink,
}: {
  name: string;
  property: JsonProperty;
  honors: ConstraintKind;
  sink: ResolutionSink;
}): IrValueConstraints | undefined => {
  const drop = ({ keyword }: { keyword: string }): void => {
    sink.onDroppedConstraint({ field: name, keyword });
  };

  const constraints: IrValueConstraints = {};

  if (honors === 'numeric') {
    const lower = resolveBound({
      inclusiveRaw: property.minimum,
      exclusiveRaw: property.exclusiveMinimum,
      inclusiveKeyword: 'minimum',
      exclusiveKeyword: 'exclusiveMinimum',
      drop,
    });
    const upper = resolveBound({
      inclusiveRaw: property.maximum,
      exclusiveRaw: property.exclusiveMaximum,
      inclusiveKeyword: 'maximum',
      exclusiveKeyword: 'exclusiveMaximum',
      drop,
    });

    Object.assign(constraints, {
      ...(lower.inclusive === undefined ? {} : { min: lower.inclusive }),
      ...(lower.exclusive === undefined ? {} : { gt: lower.exclusive }),
      ...(upper.inclusive === undefined ? {} : { max: upper.inclusive }),
      ...(upper.exclusive === undefined ? {} : { lt: upper.exclusive }),
    });
  } else {
    for (const keyword of NUMERIC_KEYWORDS) {
      if (isDeclared({ value: property[keyword] })) {
        drop({ keyword });
      }
    }
  }

  if (honors === 'string') {
    const min = lengthValue({ value: property.minLength });
    const max = lengthValue({ value: property.maxLength });
    const regex = compilablePattern({ value: property.pattern });

    for (const [keyword, honored] of [
      ['minLength', min],
      ['maxLength', max],
      ['pattern', regex],
    ] as const) {
      if (isDeclared({ value: property[keyword] }) && honored === undefined) {
        drop({ keyword });
      }
    }

    Object.assign(constraints, {
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(regex === undefined ? {} : { regex }),
    });
  } else {
    for (const keyword of STRING_KEYWORDS) {
      if (isDeclared({ value: property[keyword] })) {
        drop({ keyword });
      }
    }
  }

  for (const keyword of UNHONORED_KEYWORDS) {
    if (isDeclared({ value: property[keyword] })) {
      drop({ keyword });
    }
  }

  return Object.keys(constraints).length === 0 ? undefined : constraints;
};

/**
 * Report every keyword a node declares that the IR cannot honor on it. Used for
 * the array and object nodes, which carry no `IrValueConstraints` of their own:
 * `honors: 'none'` makes every declared keyword unhonorable, so this call is
 * purely its reporting side effect (it can only ever return `undefined`).
 */
const reportUnhonorableKeywords = ({
  name,
  property,
  sink,
}: {
  name: string;
  property: JsonProperty;
  sink: ResolutionSink;
}): void => {
  collectConstraints({ name, property, honors: 'none', sink });
};

/** Attach the honorable constraints of `property` to an already-shaped field. */
const withConstraints = ({
  field,
  property,
  honors,
  sink,
}: {
  field: IrActionField;
  property: JsonProperty;
  honors: ConstraintKind;
  sink: ResolutionSink;
}): IrActionField => {
  const constraints = collectConstraints({ name: field.name, property, honors, sink });

  return constraints === undefined ? field : { ...field, constraints };
};

/**
 * The honest fallback node for a declared shape the IR cannot express: the IR
 * `json` scalar, which renders as `z.unknown()`. It is deliberately NOT the
 * untyped scalar (`z.string()`) — telling the agent that an array or an object
 * is a string is the exact defect ONT-042 A fixes, and `z.unknown()` at least
 * admits the values the spec allows instead of rejecting all of them.
 */
const unknownField = ({
  name,
  required,
  list,
}: {
  name: string;
  required: boolean;
  list: boolean;
}): IrActionField => ({
  name,
  kind: 'scalar',
  scalar: 'json',
  ...(list ? { list: true } : {}),
  optional: !required,
});

/**
 * Map one JSON Schema property node into an action input field.
 *
 * `enum` wins over `type` (unchanged). Otherwise `type: array` recurses into
 * `items` and sets `list`, and `type: object` recurses into `properties` and
 * becomes a nested `IrActionField[]`; everything else stays the scalar/untyped
 * mapping it was. A shape the IR has no room for — an array of arrays, an object
 * with no declared properties, or nesting past `MAX_NESTING` — is reported and
 * rendered as `z.unknown()` rather than quietly becoming a string.
 */
const mapProperty = ({
  doc,
  name,
  property,
  required,
  sink,
  depth = 0,
}: {
  doc: unknown;
  name: string;
  property: JsonProperty;
  required: boolean;
  sink: ResolutionSink;
  depth?: number;
}): IrActionField => {
  if (Array.isArray(property.enum)) {
    return withConstraints({
      field: {
        name,
        kind: 'enum',
        enumValues: property.enum.map((v) => String(v)),
        optional: !required,
      },
      property,
      honors: 'none',
      sink,
    });
  }

  if (property.type === 'array') {
    return mapArrayProperty({ doc, name, property, required, sink, depth });
  }

  if (property.type === 'object') {
    return mapObjectProperty({ doc, name, property, required, sink, depth });
  }

  const scalar = property.type === undefined ? undefined : JSON_TYPE_TO_SCALAR[property.type];
  const honors: ConstraintKind =
    scalar === 'int' || scalar === 'float'
      ? 'numeric'
      : // An untyped property renders as `z.string()`, so string keywords bind.
        scalar === 'string' || scalar === undefined
        ? 'string'
        : 'none';

  return withConstraints({
    field: {
      name,
      kind: 'scalar',
      ...(scalar === undefined ? {} : { scalar }),
      optional: !required,
    },
    property,
    honors,
    sink,
  });
};

/** Map a `type: array` property: the item's kind, carried under `list: true`. */
const mapArrayProperty = ({
  doc,
  name,
  property,
  required,
  sink,
  depth,
}: {
  doc: unknown;
  name: string;
  property: JsonProperty;
  required: boolean;
  sink: ResolutionSink;
  depth: number;
}): IrActionField => {
  // Keywords sitting on the ARRAY node itself (`minItems`, or a stray
  // `minLength`) bind nothing the IR carries — reported here; the ITEM's own
  // keywords are read by the recursive call below and honored there.
  reportUnhonorableKeywords({ name, property, sink });

  if (property.items === undefined) {
    // An array of anything is exactly what was declared — nothing is dropped.
    return { name, kind: 'scalar', scalar: 'json', list: true, optional: !required };
  }

  if (depth >= MAX_NESTING) {
    sink.onDroppedShape({ field: name, detail: `nested deeper than ${MAX_NESTING} levels` });
    return unknownField({ name, required, list: true });
  }

  const items = resolveSchemaNode({ doc, node: property.items, sink });

  if (items === undefined) {
    // The `$ref` was unresolvable and already counted; the array survives.
    return unknownField({ name, required, list: true });
  }

  const item = mapProperty({
    doc,
    name,
    property: items as JsonProperty,
    required,
    sink,
    depth: depth + 1,
  });

  if (item.list === true) {
    // `list` is a boolean, so an array OF an array has no representation.
    sink.onDroppedShape({ field: name, detail: 'array of arrays' });
    return unknownField({ name, required, list: true });
  }

  return { ...item, list: true };
};

/** Map a `type: object` property into a nested `z.object({...})` field. */
const mapObjectProperty = ({
  doc,
  name,
  property,
  required,
  sink,
  depth,
}: {
  doc: unknown;
  name: string;
  property: JsonProperty;
  required: boolean;
  sink: ResolutionSink;
  depth: number;
}): IrActionField => {
  reportUnhonorableKeywords({ name, property, sink });

  if (property.properties === undefined || Object.keys(property.properties).length === 0) {
    sink.onDroppedShape({ field: name, detail: 'object with no declared properties' });
    return unknownField({ name, required, list: false });
  }

  if (depth >= MAX_NESTING) {
    sink.onDroppedShape({ field: name, detail: `nested deeper than ${MAX_NESTING} levels` });
    return unknownField({ name, required, list: false });
  }

  return {
    name,
    kind: 'object',
    fields: mapObjectProperties({
      doc,
      schema: property as JsonBodySchema,
      sink,
      depth: depth + 1,
    }),
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
  depth = 0,
}: {
  doc: unknown;
  schema: JsonBodySchema;
  sink: ResolutionSink;
  forceOptional?: boolean;
  depth?: number;
}): IrActionField[] => {
  const fields: IrActionField[] = [];
  const requiredSet = new Set(schema.required ?? []);

  for (const [name, rawProperty] of Object.entries(schema.properties ?? {})) {
    if (name === UNSAFE_KEY) {
      // Emitting it would set the prototype of the generated object literal
      // rather than declare the key, so the field would vanish without a trace.
      sink.onUnsafeKey({ field: name });
      continue;
    }

    const required = !forceOptional && requiredSet.has(name);
    const ref = refOf({ value: rawProperty });

    if (ref !== undefined) {
      const result = resolveLocalRef({ doc, ref });

      if (!result.ok) {
        sink.onUnresolvable({ reason: result.reason });
        fields.push(mapProperty({ doc, name, property: {}, required, sink, depth }));
        continue;
      }

      fields.push(
        mapProperty({ doc, name, property: result.value as JsonProperty, required, sink, depth }),
      );
      continue;
    }

    fields.push(
      mapProperty({ doc, name, property: rawProperty as JsonProperty, required, sink, depth }),
    );
  }

  return fields;
};

/**
 * Take the first definition of each property name across composed branches,
 * reporting a LATER branch that redefines a name the first one already claimed
 * (ONT-042 F). Two branches declaring an identical property raise nothing — that
 * is the common `allOf` idiom, not a loss — but a second branch declaring
 * `{"dup": {"type": "string", "maxLength": 3}}` against a first branch's
 * `{"dup": {"type": "integer", "minimum": 5}}` really does lose the string
 * definition, and that used to happen in silence.
 */
const firstWins = ({
  fields,
  seen,
  out,
  sink,
}: {
  fields: IrActionField[];
  seen: Map<string, string>;
  out: IrActionField[];
  sink: ResolutionSink;
}): void => {
  for (const field of fields) {
    const shape = JSON.stringify(field);
    const kept = seen.get(field.name);

    if (kept !== undefined) {
      if (kept !== shape) {
        sink.onShadowedProperty({ field: field.name });
      }
      continue;
    }

    seen.set(field.name, shape);
    out.push(field);
  }
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
  const seen = new Map<string, string>();

  for (const branch of branches) {
    const resolved = resolveSchemaNode({ doc, node: branch, sink });

    if (resolved === undefined) {
      continue;
    }

    firstWins({
      fields: mapObjectProperties({ doc, schema: resolved, sink }),
      seen,
      out: fields,
      sink,
    });
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
  const seen = new Map<string, string>();

  for (const branch of branches) {
    const resolved = resolveSchemaNode({ doc, node: branch, sink });

    if (resolved === undefined) {
      continue;
    }

    firstWins({
      fields: mapObjectProperties({ doc, schema: resolved, sink, forceOptional: true }),
      seen,
      out: fields,
      sink,
    });
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

/**
 * Whether a media type carries a JSON payload. Covers the exact
 * `application/json`, the `+json` structured-syntax suffix
 * (`application/merge-patch+json`, `application/vnd.api+json`), and any of them
 * carrying parameters (`application/json; charset=utf-8`).
 */
const isJsonMediaType = ({ mediaType }: { mediaType: string }): boolean => {
  const base = (mediaType.split(';')[0] ?? '').trim().toLowerCase();

  return base === 'application/json' || base.endsWith('+json');
};

/**
 * Resolve a request body's `content` map to the ONE media type whose schema is
 * mapped (plan D4, ONT-042 B). JSON is preferred; when the spec declares none,
 * the first other entry that carries a schema is used and REPORTED, because
 * `application/x-www-form-urlencoded`, `multipart/form-data` and
 * `application/xml` all declare an ordinary JSON Schema and mapping it is
 * strictly more faithful than the old behavior — which read
 * `content['application/json']` only and turned the whole body into
 * `z.object({})` with no diagnostic at all. A content map where nothing declares
 * a `schema` is reported as a skipped body.
 */
const chooseBodySchema = ({
  content,
  label,
  sink,
}: {
  content: Record<string, { schema?: JsonBodySchema }>;
  label: string;
  sink: ResolutionSink;
}): JsonBodySchema | undefined => {
  const mediaTypes = Object.keys(content).sort();
  const withSchema = mediaTypes.filter((mediaType) => content[mediaType]?.schema !== undefined);
  const chosen = withSchema.find((mediaType) => isJsonMediaType({ mediaType })) ?? withSchema[0];

  if (chosen === undefined) {
    if (mediaTypes.length > 0) {
      sink.onSkippedBody({ label, mediaTypes: mediaTypes.join(', ') });
    }

    return undefined;
  }

  if (!isJsonMediaType({ mediaType: chosen })) {
    sink.onNonJsonBody({ label, mediaType: chosen });
  }

  return content[chosen]?.schema;
};

const collectInput = ({
  doc,
  operation,
  label,
  sink,
}: {
  doc: unknown;
  operation: OpenApiOperation;
  label: string;
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

    if (param.name === UNSAFE_KEY) {
      sink.onUnsafeKey({ field: param.name });
      continue;
    }

    fields.push(
      mapProperty({
        doc,
        name: param.name,
        property: param.schema ?? {},
        required: param.required === true,
        sink,
      }),
    );
  }

  const content = operation.requestBody?.content;

  if (content !== undefined) {
    const schema = chooseBodySchema({ content, label, sink });

    if (schema !== undefined) {
      fields.push(...collectBodyFields({ doc, schema, sink }));
    }
  }

  return fields;
};

/** How many entries an aggregated skip-with-warning line names before truncating. */
const DROPPED_SAMPLE = 10;

/** Name the reported entries, truncating a large spec's list to stay readable. */
const listDropped = ({ dropped }: { dropped: Set<string> }): string => {
  const entries = [...dropped];
  const shown = entries.slice(0, DROPPED_SAMPLE).join(', ');

  return entries.length <= DROPPED_SAMPLE
    ? shown
    : `${shown}, +${entries.length - DROPPED_SAMPLE} more`;
};

/** Parse an OpenAPI JSON document into scanned write actions. */
export const scanOpenApiJson = ({
  source,
  label = 'JSON',
}: {
  source: string;
  /** The file this source came from, named in the parse diagnostic (ONT-042 C). */
  label?: string;
}): ScannedSource => {
  const scanned = emptySource();

  let doc: { paths?: Record<string, Record<string, OpenApiOperation>> };
  try {
    doc = JSON.parse(source) as typeof doc;
  } catch (err) {
    scanned.warnings.push(
      `openapi: could not parse ${label} — ${err instanceof Error ? err.message : String(err)}. Fix the JSON syntax (a trailing comma or a comment is the usual cause) and re-run; the spec is otherwise ignored.`,
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

  // `<field>.<keyword>` entries, deduped and kept in scan order (paths and
  // methods are already iterated sorted, so the report is deterministic).
  const droppedConstraints = new Set<string>();
  const droppedShapes = new Set<string>();
  const shadowedProperties = new Set<string>();
  const nonJsonBodies = new Set<string>();
  const skippedBodies = new Set<string>();
  const unsafeKeys = new Set<string>();

  const sink: ResolutionSink = {
    onUnresolvable: ({ reason }) => {
      unresolvable[reason] += 1;
    },
    onComposition: () => {
      compositionOps += 1;
    },
    onDroppedConstraint: ({ field, keyword }) => {
      droppedConstraints.add(`${field}.${keyword}`);
    },
    onDroppedShape: ({ field, detail }) => {
      droppedShapes.add(`${field} (${detail})`);
    },
    onShadowedProperty: ({ field }) => {
      shadowedProperties.add(field);
    },
    onNonJsonBody: ({ label: op, mediaType }) => {
      nonJsonBodies.add(`${op} (${mediaType})`);
    },
    onSkippedBody: ({ label: op, mediaTypes }) => {
      skippedBodies.add(`${op} (${mediaTypes})`);
    },
    onUnsafeKey: ({ field }) => {
      unsafeKeys.add(field);
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
        input: collectInput({
          doc,
          operation,
          label: `${method.toUpperCase()} ${path}`,
          sink,
        }),
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

  if (droppedConstraints.size > 0) {
    scanned.warnings.push(
      `openapi: dropped ${droppedConstraints.size} declared value constraint(s) the generated input cannot enforce (${listDropped({ dropped: droppedConstraints })}) — the emitted schema is weaker than the spec there; add the check by hand if the action needs it`,
    );
  }

  if (droppedShapes.size > 0) {
    scanned.warnings.push(
      `openapi: ${droppedShapes.size} declared shape(s) the generated input cannot express (${listDropped({ dropped: droppedShapes })}) — emitted as z.unknown(), which accepts the value instead of rejecting it; tighten the schema by hand if the action needs it`,
    );
  }

  if (shadowedProperties.size > 0) {
    scanned.warnings.push(
      `openapi: ${shadowedProperties.size} composed-body property(ies) declared differently in more than one branch (${listDropped({ dropped: shadowedProperties })}) — only the FIRST branch's definition is kept; the later one(s) are discarded`,
    );
  }

  if (nonJsonBodies.size > 0) {
    scanned.warnings.push(
      `openapi: ${nonJsonBodies.size} request body(ies) declare no JSON content (${listDropped({ dropped: nonJsonBodies })}) — the inputs were mapped from that media type's schema, so they describe the declared fields, not the wire encoding; review them before wiring up execute`,
    );
  }

  if (skippedBodies.size > 0) {
    scanned.warnings.push(
      `openapi: skipped ${skippedBodies.size} request body(ies) whose content declares no schema (${listDropped({ dropped: skippedBodies })}) — those actions have no inputs from their body; add them by hand if the action needs them`,
    );
  }

  if (unsafeKeys.size > 0) {
    scanned.warnings.push(
      `openapi: skipped ${unsafeKeys.size} field(s) whose name a generated object literal cannot carry (${listDropped({ dropped: unsafeKeys })}) — a "${UNSAFE_KEY}" key sets the object's prototype instead of declaring the field, so it would vanish from the schema and the request; rename it in the spec or add it by hand`,
    );
  }

  return scanned;
};

/** The conventional root filenames that identify a spec by NAME, not by content. */
const PREFERRED_SPECS = ['openapi.json', 'swagger.json'];

/**
 * The OpenAPI scanner (plan D4). `detect` finds an OpenAPI 3.x JSON document at
 * the repo root (or the first `*.json` that self-identifies via `openapi`);
 * when only a YAML spec exists, it surfaces the convert-to-JSON hint as a
 * warning so a YAML-first user is never told "nothing found".
 *
 * A file at one of the CONVENTIONAL names is also claimed when it does not
 * parse, so `scan` can surface the real syntax error (ONT-042 C). The
 * content-sweep over other `*.json` files keeps requiring a successful parse:
 * an unrelated broken JSON file elsewhere in the repo is not this scanner's to
 * complain about.
 */
export const openapiScanner: Scanner = {
  name: 'openapi',

  detect: ({ cwd }) => {
    const preferred = PREFERRED_SPECS.map((rel) => join(cwd, rel))
      .filter((abs) => existsSync(abs))
      .filter((abs) => classifyJson({ filePath: abs }) !== 'other');

    if (preferred.length > 0) {
      return preferred;
    }

    const jsonHits = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => join(cwd, e.name))
      .filter((abs) => classifyJson({ filePath: abs }) === 'openapi')
      .sort();

    return jsonHits;
  },

  scan: ({ filePath }) =>
    scanOpenApiJson({ source: readFileSync(filePath, 'utf8'), label: basename(filePath) }),
};

/** Whether a YAML OpenAPI/Swagger spec exists at the repo root (plan D4). */
export const hasYamlSpec = ({ cwd }: { cwd: string }): boolean =>
  YAML_CANDIDATES.some((rel) => existsSync(join(cwd, rel)));
