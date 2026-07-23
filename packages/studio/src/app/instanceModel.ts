import type { Edge, Node } from '@xyflow/react';

import type { InstanceEmployee, InstanceService, InstanceTeam } from '../snapshot/instances';

/** The studio's two source categories: the ONT-005 type map / the instance graph. */
export type Category = 'db' | 'human';

/** Data carried by a person instance node. */
export interface PersonNodeData extends Record<string, unknown> {
  employee: InstanceEmployee;
  /** Node radius in px, derived monotonically from `storyPointsTotal`. */
  radius: number;
  active: boolean;
}

/** Data carried by a place instance node (a service or a team hub). */
export interface PlaceNodeData extends Record<string, unknown> {
  /** Which instance-kind this place node represents (drives the DOM attribute). */
  kind: 'service' | 'team';
  label: string;
  service?: InstanceService;
  team?: InstanceTeam;
}

/** Data carried by a directed, weight-scaled `helps` edge. */
export interface HelpsEdgeData extends Record<string, unknown> {
  weight: number;
}

/** Data carried by a `works_on` / `member_of` edge (person → place). */
export interface WorksOnEdgeData extends Record<string, unknown> {
  weight: number;
  variant: 'worksOn' | 'memberOf';
}

export type PersonNode = Node<PersonNodeData, 'person'>;
export type PlaceNode = Node<PlaceNodeData, 'service'>;
export type InstanceNode = PersonNode | PlaceNode;

export type HelpsEdge = Edge<HelpsEdgeData, 'helps'>;
export type WorksOnEdge = Edge<WorksOnEdgeData, 'worksOn'>;
export type MemberOfEdge = Edge<WorksOnEdgeData, 'memberOf'>;
export type InstanceEdge = HelpsEdge | WorksOnEdge | MemberOfEdge;

/** React Flow node id for a person instance. */
export const personNodeId = ({ accountId }: { accountId: string }): string => `person:${accountId}`;

/** React Flow node id for a service instance. */
export const serviceNodeId = ({ id }: { id: string }): string => `svc:${id}`;

/** React Flow node id for a team instance. */
export const teamNodeId = ({ id }: { id: string }): string => `team:${id}`;

const RADIUS_MIN = 26;
const RADIUS_MAX = 64;

/**
 * Map a person's `storyPointsTotal` to a node radius (plan section 3.3):
 * monotonic (more points → larger) with min/max clamps so an isolated or
 * zero-point person is still a legible node and a very high total stays bounded.
 * Uses a square-root curve so the *area* tracks points without runaway growth.
 */
export const personRadius = ({ storyPointsTotal }: { storyPointsTotal: number }): number => {
  const points = Number.isFinite(storyPointsTotal) ? Math.max(0, storyPointsTotal) : 0;

  return Math.min(RADIUS_MAX, RADIUS_MIN + Math.sqrt(points) * 3);
};

const WIDTH_MIN = 1;
const WIDTH_MAX = 6;

/**
 * Map an edge weight to a stroke width (plan section 3.3): monotonic and
 * clamped to a max so a very heavy edge stays readable and a weight-1 edge is
 * still visible. Pure and unit-tested on the boundaries.
 */
export const edgeWidth = ({ weight }: { weight: number }): number => {
  const w = Number.isFinite(weight) ? Math.max(0, weight) : 0;

  return Math.min(WIDTH_MAX, WIDTH_MIN + w * 0.7);
};

/** Window event a person node dispatches on click, routed to App selection. */
export const SELECT_PERSON_EVENT = 'orangerail:select-person';
