import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  getShape,
  isNotImplemented,
  isOptionalField,
  type Registry,
} from 'orangerail-core';

import { fieldTypeName } from './field';
import type {
  ApprovalKind,
  GraphSnapshot,
  SnapshotAction,
  SnapshotField,
  SnapshotLink,
  SnapshotObject,
  WhereKind,
} from './types';

export type {
  ApprovalKind,
  GraphSnapshot,
  ReadAccessKind,
  SnapshotAction,
  SnapshotField,
  SnapshotLink,
  SnapshotObject,
  WhereKind,
} from './types';

export { buildInstanceSnapshot } from './instances';
export type {
  ComplexityMix,
  InstanceEdge,
  InstanceEmployee,
  InstanceIncident,
  InstanceService,
  InstanceSnapshot,
  InstanceTeam,
  MetricValue,
} from './instances';

const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name);

const buildFields = ({
  schema,
}: {
  schema: Parameters<typeof getShape>[0]['schema'];
}): SnapshotField[] => {
  const shape = getShape({ schema });

  return Object.keys(shape)
    .sort()
    .map((name) => ({
      name,
      type: fieldTypeName({ node: shape[name] }),
      optional: isOptionalField({ node: shape[name] }),
      inLink: false,
    }));
};

const buildObjects = ({ registry }: { registry: Registry }): SnapshotObject[] =>
  [...registry.listObjects()].sort(byName).map((object) => ({
    name: object.name,
    fields: buildFields({ schema: object.schema }),
    readAccess: object.readAccess,
    hasResolve: object.resolve !== undefined,
  }));

const buildLinks = ({ registry }: { registry: Registry }): SnapshotLink[] =>
  [...registry.listLinks()].sort(byName).map((link) => ({
    id: link.name,
    from: link.from.name,
    to: link.to.name,
    cardinality: link.cardinality,
  }));

const buildActions = ({ registry }: { registry: Registry }): SnapshotAction[] =>
  [...registry.listActions()].sort(byName).map((action) => {
    const policy = action.policy;
    const approval: ApprovalKind = policy?.approval === 'required' ? 'required' : 'auto';

    let where: WhereKind = 'none';
    let whereText: string | undefined;

    if (policy?.where !== undefined) {
      if (typeof policy.where === 'function') {
        where = 'functional';
      } else {
        where = 'declarative';
        whereText = `${policy.where.field} ${policy.where.op} ${canonicalJson({ value: policy.where.value })}`;
      }
    }

    const base: SnapshotAction = {
      name: action.name,
      approval,
      roles: policy?.roles ?? [],
      where,
      notImplemented: isNotImplemented({ execute: action.execute }),
    };

    return {
      ...base,
      ...(action.target ? { target: action.target.name } : {}),
      ...(whereText === undefined ? {} : { whereText }),
    };
  });

/**
 * Build the deterministic graph snapshot from an ontology registry (plan
 * section 3.2). Pure, no I/O; objects/links/actions are alphabetically ordered
 * (same rule as docs-gen). Governance facts are truthful: a functional `where`
 * is marked `functional`, never pretended declarative; `notImplemented` is
 * carried through. All strings pass through verbatim — the frontend renders
 * them as text nodes only (AC-8), so no escaping happens at this layer.
 */
export const buildSnapshot = ({ registry }: { registry: Registry }): GraphSnapshot => ({
  objects: buildObjects({ registry }),
  links: buildLinks({ registry }),
  actions: buildActions({ registry }),
});

/**
 * Absolute path of the prebuilt browser app (`dist/app`), resolved relative to
 * this compiled node entry at `dist/node/index.js`. The CLI serves this
 * directory statically (plan section 3.1 / 3.6).
 */
export const studioAppDir = (): string => fileURLToPath(new URL('../app', import.meta.url));
