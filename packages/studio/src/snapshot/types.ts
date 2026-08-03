/**
 * The studio wire format — the JSON the CLI serves at `/api/registry` and the
 * browser app consumes. Kept in this node-consumable entry so the CLI and the
 * app share one source of truth for the shape without the CLI importing any
 * React/Vite code (plan section 3.1 / 3.2).
 */

import type { ActionOp } from 'orangerail-core';

export type { ActionOp };

/** How an object's read exposure is declared (mirrors core `ReadAccess`). */
export type ReadAccessKind = 'authenticated' | 'anonymous';

/** One top-level field of an object type, rendered as a card row. */
export interface SnapshotField {
  /** The field name, verbatim (rendered as inert text — AC-8). */
  name: string;
  /** Display type name with optional/nullable/default wrappers unwrapped. */
  type: string;
  /** Whether the caller may omit the field (probed via the public zod API). */
  optional: boolean;
  /**
   * Whether the field participates in a link. Always `false` in v0: core links
   * bind object-to-object, not field-to-field, so no field carries a link
   * marker. Retained in the wire shape for forward compatibility (plan 3.2).
   */
  inLink: boolean;
}

/** An object type as a schema-card node. */
export interface SnapshotObject {
  name: string;
  fields: SnapshotField[];
  readAccess: ReadAccessKind;
  /** Whether the object carries a read `resolve` contract. */
  hasResolve: boolean;
}

/** A link type as a cardinality-labelled edge. */
export interface SnapshotLink {
  id: string;
  from: string;
  to: string;
  cardinality: 'one' | 'many';
}

/** Whether an action auto-executes or requires human approval. */
export type ApprovalKind = 'auto' | 'required';

/** How an action's `where` guard is expressed (governance-truthful). */
export type WhereKind = 'none' | 'declarative' | 'functional';

/** An action type as a governed, policy-aware graph affordance. */
export interface SnapshotAction {
  name: string;
  /**
   * The CRUD operation the action declares, carried through verbatim from
   * `ActionDefinition.op` (ONT-091). Absent means the action DECLARED none —
   * never "checked, and it is not a delete". Nothing derives it here; an
   * ontology generated before 0.1.3 carries none at all, which is why the map
   * states how many actions declared one.
   */
  op?: ActionOp;
  /** The target object name, when the action targets one. */
  target?: string;
  approval: ApprovalKind;
  /** Approver roles (empty unless the action is governed with roles). */
  roles: string[];
  where: WhereKind;
  /** Human-readable guard text for a declarative `where` (e.g. `status eq "draft"`). */
  whereText?: string;
  /** Whether the action's `execute` is the `notImplemented` stub. */
  notImplemented: boolean;
}

/** The complete, deterministic graph snapshot (alphabetically ordered). */
export interface GraphSnapshot {
  objects: SnapshotObject[];
  links: SnapshotLink[];
  actions: SnapshotAction[];
}
