import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import '@xyflow/react/dist/style.css';

import type { GraphSnapshot } from '../snapshot/types';
import styles from './App.module.css';
import { CardinalityMarkers } from './edges/CardinalityMarkers';
import { ActionEdge } from './edges/ActionEdge';
import { LinkEdge } from './edges/LinkEdge';
import { ParticleOverlay } from './edges/ParticleOverlay';
import { DetailPanel } from './DetailPanel';
import { EmptyState, isEmptySnapshot } from './EmptyState';
import { fitAll } from './fit';
import { actionEdgeId, buildGraph } from './graph';
import { computeHighlights, type Focus } from './highlight';
import { computeLayout } from './layout';
import {
  HOVER_ACTION_EVENT,
  SELECT_ACTION_EVENT,
  type ObjectNodeData,
  type ShowMode,
  type StudioEdge,
  type StudioNode,
} from './model';
import { ActionNode } from './nodes/ActionNode';
import { ObjectCard } from './nodes/ObjectCard';
import { Toolbar } from './Toolbar';

const NODE_TYPES = { object: ObjectCard, action: ActionNode } as unknown as NodeTypes;
const EDGE_TYPES = { link: LinkEdge, action: ActionEdge } as unknown as EdgeTypes;

const initialShowMode = (): ShowMode =>
  new URLSearchParams(window.location.search).get('showMode') === 'name' ? 'name' : 'all';

/** Value equality for a hover/selection focus (so redundant hovers no-op). */
const sameFocus = ({ a, b }: { a: Focus; b: Focus }): boolean =>
  a === b || (a !== null && b !== null && a.type === b.type && a.name === b.name);

/**
 * True when a client point lies within an element's box. A committed hover
 * rebuilds the graph, which React Flow renders by briefly detaching the edge
 * svg; under a stationary cursor that frame emits a PHANTOM mouseleave carrying
 * the (unchanged) cursor coordinates, which are still inside the hovered
 * element. Ignoring any leave whose pointer is still inside kills the ~13Hz
 * hover oscillation this would otherwise sustain — and, unlike a timing guard,
 * works for a single discrete move that stops on the element.
 */
const pointerInside = ({
  element,
  x,
  y,
}: {
  element: Element | null;
  x: number;
  y: number;
}): boolean => {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();

  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
};

/**
 * The studio surface: fetch the registry, run ELK layout, render the graph
 * through React Flow with a view-only configuration (plan section 3.8), and
 * wire the toolbar, detail panel, live-reload SSE client, and the single
 * highlight pass. Draggable nodes are ephemeral view state (Liam parity); a
 * selection/reload re-derives node data, which is intentional in v0.
 */
const Studio = () => {
  const rf = useReactFlow<StudioNode, StudioEdge>();

  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [layoutTick, setLayoutTick] = useState(0);
  const [showMode, setShowMode] = useState<ShowMode>(initialShowMode());
  const [active, setActive] = useState<Focus>(null);
  const [hover, setHover] = useState<Focus>(null);
  const [reloadError, setReloadError] = useState(false);

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Apply hover on a short debounce. Hover recomputes the highlight pass, which
  // re-derives every node's data and re-pushes the React Flow node array; doing
  // that synchronously on pointer-enter can reset React Flow's in-flight click
  // tracking and drop the very click a user (or a test driver) is making. The
  // debounce lets a click settle first, and is imperceptible for real hovering.
  // The functional update returns the previous focus when unchanged so a
  // repeated (e.g. phantom) enter for the same node causes no re-render.
  const scheduleHover = useCallback(({ focus }: { focus: Focus }) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(
      () => setHover((prev) => (sameFocus({ a: prev, b: focus }) ? prev : focus)),
      90,
    );
  }, []);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StudioEdge>([]);

  const refetch = useCallback(async () => {
    try {
      const snap: GraphSnapshot = await (await fetch('/api/registry')).json();
      const pos = await computeLayout({ snapshot: snap });

      setSnapshot(snap);
      setPositions(pos);
      setLayoutTick((tick) => tick + 1);
      setReloadError(false);
    } catch {
      setReloadError(true);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('change', () => void refetch());
    events.addEventListener('reload-error', () => setReloadError(true));

    return () => events.close();
  }, [refetch]);

  useEffect(() => {
    const handler = (event: Event) =>
      setActive({ type: 'action', name: (event as CustomEvent<string>).detail });
    window.addEventListener(SELECT_ACTION_EVENT, handler);

    return () => window.removeEventListener(SELECT_ACTION_EVENT, handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const name = (event as CustomEvent<string | null>).detail;
      scheduleHover({ focus: name ? { type: 'action', name } : null });
    };
    window.addEventListener(HOVER_ACTION_EVENT, handler);

    return () => window.removeEventListener(HOVER_ACTION_EVENT, handler);
  }, [scheduleHover]);

  const highlights = useMemo(
    () => (snapshot ? computeHighlights({ snapshot, active, hover }) : null),
    [snapshot, active, hover],
  );

  const built = useMemo(
    () =>
      snapshot && highlights
        ? buildGraph({ snapshot, positions, showMode, highlights })
        : { nodes: [] as StudioNode[], edges: [] as StudioEdge[] },
    [snapshot, highlights, positions, showMode],
  );

  // Edge ids that carry flow particles: highlighted link edges and highlighted
  // (or active) targeted-action self-loops. Drives the decoupled overlay; the
  // in-edge particle render was removed to stop the hover remount loop.
  const activeEdgeIds = useMemo(() => {
    if (!snapshot || !highlights) {
      return [] as string[];
    }

    const ids: string[] = [];

    for (const link of snapshot.links) {
      if (highlights.links[link.id]?.highlighted) {
        ids.push(link.id);
      }
    }

    for (const action of snapshot.actions) {
      const state = highlights.actions[action.name];

      if (action.target && (state?.highlighted || state?.active)) {
        ids.push(actionEdgeId({ name: action.name }));
      }
    }

    return ids;
  }, [snapshot, highlights]);

  useEffect(() => {
    setNodes(built.nodes);
  }, [built.nodes, setNodes]);

  useEffect(() => {
    setEdges(built.edges);
  }, [built.edges, setEdges]);

  useEffect(() => {
    if (positions.size === 0) {
      return;
    }

    // Wait for node measurement (~60ms), then two animation frames so the
    // self-loop action pills (EdgeLabelRenderer) have painted before we measure
    // their extent — otherwise the fit falls back to node-only bounds and clips
    // them (defect 1).
    let frame = 0;
    const timer = setTimeout(() => {
      frame = requestAnimationFrame(() => requestAnimationFrame(() => fitAll({ rf, duration: 0 })));
    }, 60);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [layoutTick, positions, rf]);

  const onNodeClick = useCallback<NodeMouseHandler<StudioNode>>((_event, node) => {
    if (node.type === 'object') {
      setActive({ type: 'object', name: (node.data as ObjectNodeData).object.name });
    }
  }, []);

  // Hover applies the same relation-highlight treatment as a click (clone spec,
  // Interaction). Object cards are React Flow nodes, so hover is wired here;
  // action pills route hover through HOVER_ACTION_EVENT (both pill surfaces).
  // Action nodes are ignored here to avoid double-clearing the pill's own hover.
  const onNodeMouseEnter = useCallback<NodeMouseHandler<StudioNode>>(
    (_event, node) => {
      if (node.type === 'object') {
        scheduleHover({
          focus: { type: 'object', name: (node.data as ObjectNodeData).object.name },
        });
      }
    },
    [scheduleHover],
  );

  const onNodeMouseLeave = useCallback<NodeMouseHandler<StudioNode>>(
    (event, node) => {
      if (node.type !== 'object') {
        return;
      }

      // Ignore a phantom leave: the cursor is still inside the card (the leave
      // was fired by a DOM re-attach, not a real exit). See `pointerInside`.
      if (pointerInside({ element: event.currentTarget, x: event.clientX, y: event.clientY })) {
        return;
      }

      scheduleHover({ focus: null });
    },
    [scheduleHover],
  );

  const handleTidy = useCallback(async () => {
    if (!snapshot) {
      return;
    }

    const pos = await computeLayout({ snapshot });
    setPositions(pos);
    setLayoutTick((tick) => tick + 1);
  }, [snapshot]);

  const handleShowMode = useCallback(({ mode }: { mode: ShowMode }) => {
    setShowMode(mode);

    const url = new URL(window.location.href);
    url.searchParams.set('showMode', mode);
    window.history.replaceState(null, '', url);

    // Switching density changes every card's size; re-fit so the graph stays
    // centered (clone spec: "Switching modes resets zoom/pan to a fit view").
    // Reuse the pill-inclusive fit path by bumping the layout tick.
    setLayoutTick((tick) => tick + 1);
  }, []);

  if (snapshot && isEmptySnapshot({ snapshot })) {
    return <EmptyState />;
  }

  return (
    <div className={styles.root} data-testid="studio-root">
      <CardinalityMarkers />

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        colorMode="dark"
        nodesConnectable={false}
        edgesFocusable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        minZoom={0.1}
        maxZoom={2}
        panOnScroll
        panOnDrag={[1, 2]}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={() => setActive(null)}
        attributionPosition="bottom-left"
      >
        <Background variant={BackgroundVariant.Dots} color="#393b3c" gap={16} size={1} />
        <ParticleOverlay activeEdgeIds={activeEdgeIds} />
      </ReactFlow>

      <Toolbar showMode={showMode} onShowMode={handleShowMode} onTidy={handleTidy} />

      {active && snapshot ? (
        <DetailPanel snapshot={snapshot} focus={active} onClose={() => setActive(null)} />
      ) : null}

      {reloadError ? (
        <div className={styles.error} data-testid="reload-error">
          Reload failed — showing the last good snapshot.
        </div>
      ) : null}
    </div>
  );
};

/** Root app: the studio surface wrapped in a React Flow provider. */
export const App = () => (
  <ReactFlowProvider>
    <Studio />
  </ReactFlowProvider>
);
