import type { Edge, Node } from '@xyflow/react';

import type { SnapshotAction, SnapshotLink, SnapshotObject } from '../snapshot/types';
import type { HelpsEdge, MemberOfEdge, PersonNode, PlaceNode, WorksOnEdge } from './instanceModel';

/** Card display density (Liam's per-node data field with a global default). */
export type ShowMode = 'all' | 'name';

/** Data carried by an object-card node. */
export interface ObjectNodeData extends Record<string, unknown> {
  object: SnapshotObject;
  showMode: ShowMode;
  active: boolean;
  highlighted: boolean;
  dim: boolean;
}

/** Data carried by a target-less action pill rendered as a node. */
export interface ActionNodeData extends Record<string, unknown> {
  action: SnapshotAction;
  active: boolean;
  highlighted: boolean;
  dim: boolean;
}

/** Data carried by a link edge. */
export interface LinkEdgeData extends Record<string, unknown> {
  link: SnapshotLink;
  highlighted: boolean;
}

/** Data carried by an action self-loop edge (a targeted action). */
export interface ActionEdgeData extends Record<string, unknown> {
  action: SnapshotAction;
  active: boolean;
  highlighted: boolean;
  dim: boolean;
  /** Index among the self-loops on the same target, for vertical staggering. */
  loopIndex: number;
  /** Total self-loops on the same target (centres the stagger). */
  loopCount: number;
}

export type ObjectNode = Node<ObjectNodeData, 'object'>;
export type ActionNode = Node<ActionNodeData, 'action'>;

/**
 * Every node kind the one shared React Flow surface can render — the db type
 * map (object/action) plus the human instance graph (person/service). The build
 * path is category-scoped (App emits one family at a time), but the surface's
 * generic must span both so `useNodesState`, fit, and the toolbar type-check
 * uniformly (plan section 3.2).
 */
export type StudioNode = ObjectNode | ActionNode | PersonNode | PlaceNode;

export type LinkEdge = Edge<LinkEdgeData, 'link'>;
export type ActionEdge = Edge<ActionEdgeData, 'action'>;

/** Every edge kind the shared surface can render (db links/actions + instance edges). */
export type StudioEdge = LinkEdge | ActionEdge | HelpsEdge | WorksOnEdge | MemberOfEdge;

/** The isolated-object group id (Liam's non-related-table-group pattern). */
export const ISOLATED_GROUP_ID = 'isolated-group';

/**
 * Window event an action pill dispatches on click. Action pills live both as
 * edge labels (targeted actions) and as nodes (target-less actions); routing
 * their selection through one window event keeps App's selection handling
 * uniform regardless of which React Flow surface the pill sits on.
 */
export const SELECT_ACTION_EVENT = 'orangerail:select-action';

/**
 * Window event an action pill dispatches on hover (`detail` = the action name
 * on enter, `null` on leave). Self-loop pills are edge labels, not React Flow
 * nodes, so `onNodeMouseEnter` never fires for them; routing pill hover through
 * one window event gives both pill surfaces the identical hover-highlight as a
 * click, matching Liam's shared-treatment semantics (clone spec, Interaction).
 */
export const HOVER_ACTION_EVENT = 'orangerail:hover-action';
