import type { Edge, Node } from '@xyflow/react';

import type { InstanceEmployee, InstanceService, InstanceTeam } from '../snapshot/instances';

/** The studio's two source categories: the ONT-005 type map / the instance graph. */
export type Category = 'db' | 'human';

/**
 * The human category's three purpose-built views (plan section 3.1 / AC-1): the
 * focus+context node-link Network, the person x person help Matrix, and the
 * people <-> services Ownership bipartite.
 */
export type ViewMode = 'network' | 'matrix' | 'ownership';

/**
 * The single relationship family the Network view renders at a time (plan
 * section 3.2c / AC-2): `helps` (person -> person), `works_on` (person ->
 * service), or `member_of` (person -> team). Default is `helps`.
 */
export type Relationship = 'helps' | 'works_on' | 'member_of';

/** Data carried by a person instance node. */
export interface PersonNodeData extends Record<string, unknown> {
  employee: InstanceEmployee;
  /** Node radius in px, derived monotonically from `storyPointsTotal`. */
  radius: number;
  active: boolean;
  /**
   * Incident-edge count in the active relationship (a person's connectivity in
   * the current view). Drives a border-weight emphasis so well-connected hubs
   * read as anchors, separate from the story-point radius channel. Optional so
   * builders that don't model connectivity (Ownership) can omit it.
   */
  degree?: number;
  /** True when a focus mode is active and this node is outside the ego set. */
  dim?: boolean;
}

/** Data carried by a place instance node (a service or a team hub). */
export interface PlaceNodeData extends Record<string, unknown> {
  /** Which instance-kind this place node represents (drives the DOM attribute). */
  kind: 'service' | 'team';
  label: string;
  service?: InstanceService;
  team?: InstanceTeam;
  /** True when this place node is the current selection (Ownership focus). */
  active?: boolean;
  /**
   * True when this place carries no edge in the active relationship (e.g. a
   * service in the `helps` view) and is not pulled into the current focus — it
   * recedes as context so the active relationship reads as the figure.
   */
  muted?: boolean;
  /** True when a focus mode is active and this node is outside the ego set. */
  dim?: boolean;
}

/** Data carried by a directed, weight-scaled `helps` edge. */
export interface HelpsEdgeData extends Record<string, unknown> {
  weight: number;
  /** True when a focus mode is active and this edge is outside the ego set. */
  dim?: boolean;
  /**
   * True when this edge is inside the active focus/hover ego set. It renders
   * emphasised and carries the flow-particle animation, mirroring the DB view's
   * highlighted links.
   */
  focused?: boolean;
}

/** Data carried by a `works_on` / `member_of` edge (person → place). */
export interface WorksOnEdgeData extends Record<string, unknown> {
  weight: number;
  variant: 'worksOn' | 'memberOf';
  /** True when a focus mode is active and this edge is outside the ego set. */
  dim?: boolean;
  /**
   * True when this edge is inside the active focus/hover ego set. It renders
   * emphasised and carries the flow-particle animation, mirroring the DB view's
   * highlighted links.
   */
  focused?: boolean;
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

export const RADIUS_MIN = 18;
export const RADIUS_MAX = 40;

/**
 * Map a person's `storyPointsTotal` to a node radius (plan section 3.2a):
 * monotonic (more points → larger) with min/max clamps so an isolated or
 * zero-point person is still a legible node and a very high total stays bounded.
 * The cap is lowered from the ONT-011 64px to 40px so the largest circle can no
 * longer swamp its neighbours (the first half of the collision-free invariant;
 * the layout de-overlap pass is the second half). Uses a square-root curve so
 * the *area* tracks points without runaway growth.
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
