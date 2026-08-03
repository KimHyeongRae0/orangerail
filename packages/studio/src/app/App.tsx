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

import type { AgentFleetSnapshot } from '../snapshot';
import type { InstanceSnapshot } from '../snapshot/instances';
import type { GraphSnapshot } from '../snapshot/types';
import styles from './App.module.css';
import { FleetView } from './FleetView';
import { CardinalityMarkers } from './edges/CardinalityMarkers';
import { ActionEdge } from './edges/ActionEdge';
import { HelpsEdge } from './edges/HelpsEdge';
import { LinkEdge } from './edges/LinkEdge';
import { ParticleOverlay } from './edges/ParticleOverlay';
import { WorksOnEdge } from './edges/WorksOnEdge';
import { DetailPanel, PersonScorecard } from './DetailPanel';
import { EmptyState, isEmptySnapshot } from './EmptyState';
import { ViewBoundary } from './ErrorBoundary';
import { AGENT_VIEW_ENABLED } from './featureFlags';
import { fitAll } from './fit';
import { actionEdgeId, buildGraph } from './graph';
import { HelpMatrix } from './HelpMatrixView';
import { buildHelpMatrix } from './helpMatrix';
import { computeHighlights, type Focus } from './highlight';
import { buildInstanceGraph } from './instanceGraph';
import { computeInstanceLayout } from './instanceLayout';
import {
  type Category,
  type PersonNodeData,
  type PlaceNodeData,
  type Relationship,
  type ViewMode,
} from './instanceModel';
import { buildOwnershipGraph } from './ownershipGraph';
import { computeOwnershipLayout } from './ownershipLayout';
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
import { PersonNode } from './nodes/PersonNode';
import { ServiceNode } from './nodes/ServiceNode';
import { Toolbar } from './Toolbar';

const NODE_TYPES = {
  object: ObjectCard,
  action: ActionNode,
  person: PersonNode,
  service: ServiceNode,
} as unknown as NodeTypes;

const EDGE_TYPES = {
  link: LinkEdge,
  action: ActionEdge,
  helps: HelpsEdge,
  worksOn: WorksOnEdge,
  memberOf: WorksOnEdge,
} as unknown as EdgeTypes;

const initialShowMode = (): ShowMode =>
  new URLSearchParams(window.location.search).get('showMode') === 'name' ? 'name' : 'all';

/** The category requested via `?category=`, or `null` when the URL is silent. */
const initialCategory = (): Category | null => {
  const value = new URLSearchParams(window.location.search).get('category');
  return value === 'db' || value === 'human' || value === 'agent' ? value : null;
};

/** The human view requested via `?view=`, defaulting to `'network'` (AC-1). */
const initialViewMode = (): ViewMode => {
  const value = new URLSearchParams(window.location.search).get('view');
  return value === 'matrix' || value === 'ownership' ? value : 'network';
};

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
 * The studio surface: fetch both the type registry (db) and the instance
 * snapshot (human), run the per-category ELK layout, and render the active
 * category through one shared React Flow surface (plan section 3.2). The db
 * category is the ONT-005 type map (unchanged: layered layout, object/action
 * types, hover-highlight, detail panel); the human category is the instance
 * graph (stress layout, person/service nodes, help/works-on edges, person
 * scorecard). The toolbar hosts the category tabs and the per-category controls.
 */
const Studio = () => {
  const rf = useReactFlow<StudioNode, StudioEdge>();

  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [instances, setInstances] = useState<InstanceSnapshot | null>(null);
  const [fleet, setFleet] = useState<AgentFleetSnapshot | null>(null);
  const [dbPositions, setDbPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [humanPositions, setHumanPositions] = useState<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const [ownershipPositions, setOwnershipPositions] = useState<
    Map<string, { x: number; y: number }>
  >(new Map());
  const [layoutTick, setLayoutTick] = useState(0);
  const [category, setCategory] = useState<Category>(initialCategory() ?? 'human');
  const [categoryPinned, setCategoryPinned] = useState(initialCategory() !== null);
  const [showMode, setShowMode] = useState<ShowMode>(initialShowMode());
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode());
  const [relationship, setRelationship] = useState<Relationship>('helps');
  const [weightThreshold, setWeightThreshold] = useState(1);
  const [active, setActive] = useState<Focus>(null);
  const [activePerson, setActivePerson] = useState<string | null>(null);
  const [activeService, setActiveService] = useState<string | null>(null);
  const [hover, setHover] = useState<Focus>(null);
  // Transient hover focus for the human graph (person / service), mirroring the
  // DB view's object hover. An active click selection always wins over a hover.
  const [hoverAccountId, setHoverAccountId] = useState<string | null>(null);
  const [hoverServiceId, setHoverServiceId] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState(false);

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Apply hover on a short debounce. Hover recomputes the highlight pass, which
  // re-derives every node's data and re-pushes the React Flow node array; doing
  // that synchronously on pointer-enter can reset React Flow's in-flight click
  // tracking and drop the very click a user (or a test driver) is making. The
  // debounce lets a click settle first, and is imperceptible for real hovering.
  const scheduleHover = useCallback(({ focus }: { focus: Focus }) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(
      () => setHover((prev) => (sameFocus({ a: prev, b: focus }) ? prev : focus)),
      90,
    );
  }, []);

  // The human-graph counterpart of `scheduleHover`: debounce a person/service
  // hover the same way (the graph rebuild on focus can otherwise drop the very
  // click a user is making). Only one of account/service is ever set.
  const scheduleHumanHover = useCallback(
    ({ accountId, serviceId }: { accountId: string | null; serviceId: string | null }) => {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => {
        setHoverAccountId(accountId);
        setHoverServiceId(serviceId);
      }, 90);
    },
    [],
  );

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StudioEdge>([]);

  const refetch = useCallback(async () => {
    try {
      const snap: GraphSnapshot = await (await fetch('/api/registry')).json();
      const pos = await computeLayout({ snapshot: snap });

      setSnapshot(snap);
      setDbPositions(pos);
      setReloadError(false);
    } catch {
      setReloadError(true);
    }

    // The instance endpoint is independent: a type-only config serves an empty
    // instance snapshot, which degrades to the db-only view (AC-4), never an error.
    try {
      const inst: InstanceSnapshot = await (await fetch('/api/instances')).json();
      const pos = await computeInstanceLayout({ snapshot: inst });
      const ownPos = await computeOwnershipLayout({ snapshot: inst });

      setInstances(inst);
      setHumanPositions(pos);
      setOwnershipPositions(ownPos);
    } catch {
      setInstances({
        employees: [],
        services: [],
        teams: [],
        incidents: [],
        edges: { helps: [], works_on: [], member_of: [] },
      });
    }

    // The agent fleet is independent again: a project with no `data/fleet.json`
    // serves the empty snapshot, which just leaves the agent category disabled.
    try {
      const fleetData: AgentFleetSnapshot = await (await fetch('/api/fleet')).json();
      setFleet(fleetData);
    } catch {
      setFleet(null);
    }

    setLayoutTick((tick) => tick + 1);
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

  const availability = useMemo(
    () => ({
      db: (snapshot?.objects.length ?? 0) > 0 || (snapshot?.actions.length ?? 0) > 0,
      human: (instances?.employees.length ?? 0) > 0,
      // Shelved for post-v0 — see AGENT_VIEW_ENABLED in ./featureFlags.
      agent: AGENT_VIEW_ENABLED && (fleet?.agentCount ?? 0) > 0,
    }),
    [snapshot, instances, fleet],
  );

  // Once both snapshots have loaded, auto-select an available category when the
  // current one has no data and the URL did not pin a choice (AC-4 degrade —
  // never leave the user on an empty broken view).
  useEffect(() => {
    if (categoryPinned || snapshot === null || instances === null) {
      return;
    }

    if (!availability[category]) {
      setCategory(availability.human ? 'human' : 'db');
      setLayoutTick((tick) => tick + 1);
    }
  }, [availability, category, categoryPinned, snapshot, instances]);

  const highlights = useMemo(
    () => (snapshot ? computeHighlights({ snapshot, active, hover }) : null),
    [snapshot, active, hover],
  );

  const built = useMemo(() => {
    // The agent category renders the FleetView DOM overlay (like the Matrix), so
    // the shared React Flow canvas holds nothing for it.
    if (category === 'agent') {
      return { nodes: [] as StudioNode[], edges: [] as StudioEdge[] };
    }

    if (category === 'human' && instances) {
      // The Matrix is a plain DOM overlay (not React Flow), so the shared canvas
      // renders nothing in that view; the surface + provider stay mounted.
      if (viewMode === 'matrix') {
        return { nodes: [] as StudioNode[], edges: [] as StudioEdge[] };
      }

      if (viewMode === 'ownership') {
        return buildOwnershipGraph({
          snapshot: instances,
          positions: ownershipPositions,
          selection: activePerson
            ? { type: 'person', accountId: activePerson }
            : activeService
              ? { type: 'service', id: activeService }
              : null,
        });
      }

      return buildInstanceGraph({
        snapshot: instances,
        positions: humanPositions,
        relationship,
        weightThreshold,
        // A click selection wins over a hover; a service focus lights the people
        // who own it (person focus takes precedence inside the builder).
        activeAccountId: activePerson ?? hoverAccountId,
        activeServiceId: activeService ?? hoverServiceId,
      });
    }

    if (snapshot && highlights) {
      return buildGraph({ snapshot, positions: dbPositions, showMode, highlights });
    }

    return { nodes: [] as StudioNode[], edges: [] as StudioEdge[] };
  }, [
    category,
    instances,
    viewMode,
    humanPositions,
    ownershipPositions,
    relationship,
    weightThreshold,
    activePerson,
    activeService,
    hoverAccountId,
    hoverServiceId,
    snapshot,
    highlights,
    dbPositions,
    showMode,
  ]);

  // The Matrix model (degree-ordered person x person help adjacency) — built
  // only for the human category so a db-only config never computes it.
  const helpMatrix = useMemo(
    () => (category === 'human' && instances ? buildHelpMatrix({ snapshot: instances }) : null),
    [category, instances],
  );

  // Edge ids that carry flow particles: db link/action highlights only. The
  // human category has no particle overlay, so its list is empty.
  const activeEdgeIds = useMemo(() => {
    // Human views animate the focused (ego) edges — the same flow particles the
    // DB view runs on its highlighted links.
    if (category === 'human') {
      return built.edges
        .filter((edge) => (edge.data as { focused?: boolean } | undefined)?.focused === true)
        .map((edge) => edge.id);
    }

    if (category !== 'db' || !snapshot || !highlights) {
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
  }, [category, built.edges, snapshot, highlights]);

  // Push nodes then edges together. The instance nodes carry explicit
  // width/height (set in `buildInstanceGraph`) so React Flow has their
  // dimensions immediately instead of waiting on an async ResizeObserver
  // measurement — without measured dimensions React Flow cannot position an
  // edge's endpoints and drops it on some (warm-cache) loads. Ordering nodes
  // before edges in one effect keeps the store consistent for both categories.
  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [built.nodes, built.edges, setNodes, setEdges]);

  const positions =
    category === 'human'
      ? viewMode === 'ownership'
        ? ownershipPositions
        : humanPositions
      : dbPositions;

  useEffect(() => {
    if (positions.size === 0) {
      return;
    }

    // Wait for node measurement (~60ms), then two animation frames so any
    // EdgeLabelRenderer content (db self-loop pills) has painted before we
    // measure its extent — otherwise the fit falls back to node-only bounds.
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
      setActivePerson(null);
      setActiveService(null);
      return;
    }

    if (node.type === 'person') {
      setActivePerson((node.data as PersonNodeData).employee.accountId);
      setActiveService(null);
      setActive(null);
      return;
    }

    if (node.type === 'service') {
      setActiveService((node.data as PlaceNodeData).service?.id ?? null);
      setActivePerson(null);
      setActive(null);
    }
  }, []);

  // Hover applies the same relation-highlight treatment as a click: an object
  // (db map), a person, or a service (human graph) all light their connections
  // on hover and animate them, exactly like a selection.
  const onNodeMouseEnter = useCallback<NodeMouseHandler<StudioNode>>(
    (_event, node) => {
      if (node.type === 'object') {
        scheduleHover({
          focus: { type: 'object', name: (node.data as ObjectNodeData).object.name },
        });
        return;
      }

      if (node.type === 'person') {
        scheduleHumanHover({
          accountId: (node.data as PersonNodeData).employee.accountId,
          serviceId: null,
        });
        return;
      }

      if (node.type === 'service') {
        scheduleHumanHover({
          accountId: null,
          serviceId: (node.data as PlaceNodeData).service?.id ?? null,
        });
      }
    },
    [scheduleHover, scheduleHumanHover],
  );

  const onNodeMouseLeave = useCallback<NodeMouseHandler<StudioNode>>(
    (event, node) => {
      if (node.type !== 'object' && node.type !== 'person' && node.type !== 'service') {
        return;
      }

      // Ignore a phantom leave: the cursor is still inside the node (the leave
      // was fired by a DOM re-attach, not a real exit). See `pointerInside`.
      if (pointerInside({ element: event.currentTarget, x: event.clientX, y: event.clientY })) {
        return;
      }

      if (node.type === 'object') {
        scheduleHover({ focus: null });
        return;
      }

      scheduleHumanHover({ accountId: null, serviceId: null });
    },
    [scheduleHover, scheduleHumanHover],
  );

  const handleTidy = useCallback(async () => {
    if (category === 'human' && instances) {
      const pos = await computeInstanceLayout({ snapshot: instances });
      setHumanPositions(pos);
      setLayoutTick((tick) => tick + 1);
      return;
    }

    if (!snapshot) {
      return;
    }

    const pos = await computeLayout({ snapshot });
    setDbPositions(pos);
    setLayoutTick((tick) => tick + 1);
  }, [category, instances, snapshot]);

  const handleCategory = useCallback(({ category: next }: { category: Category }) => {
    setCategory(next);
    setCategoryPinned(true);
    setActive(null);
    setActivePerson(null);
    setActiveService(null);
    setHoverAccountId(null);
    setHoverServiceId(null);

    const url = new URL(window.location.href);
    url.searchParams.set('category', next);
    window.history.replaceState(null, '', url);

    // Switching categories fully replaces the node/edge arrays; re-fit so the
    // new view is centered (reuse the fit path by bumping the layout tick).
    setLayoutTick((tick) => tick + 1);
  }, []);

  const handleShowMode = useCallback(({ mode }: { mode: ShowMode }) => {
    setShowMode(mode);

    const url = new URL(window.location.href);
    url.searchParams.set('showMode', mode);
    window.history.replaceState(null, '', url);

    setLayoutTick((tick) => tick + 1);
  }, []);

  const handleViewMode = useCallback(({ view }: { view: ViewMode }) => {
    setViewMode(view);
    setActive(null);
    setActivePerson(null);
    setActiveService(null);
    setHoverAccountId(null);
    setHoverServiceId(null);

    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    window.history.replaceState(null, '', url);

    // Switching views replaces the surface content; re-fit by bumping the tick.
    setLayoutTick((tick) => tick + 1);
  }, []);

  const handleRelationship = useCallback(
    ({ relationship: next }: { relationship: Relationship }) => {
      setRelationship(next);
    },
    [],
  );

  const handleWeightThresholdInc = useCallback(() => {
    setWeightThreshold((prev) => prev + 1);
  }, []);

  const handleWeightThresholdDec = useCallback(() => {
    setWeightThreshold((prev) => Math.max(1, prev - 1));
  }, []);

  const bothEmpty =
    snapshot !== null &&
    isEmptySnapshot({ snapshot }) &&
    instances !== null &&
    instances.employees.length === 0;

  if (bothEmpty) {
    return <EmptyState />;
  }

  const selectedPerson =
    activePerson && instances
      ? instances.employees.find((e) => e.accountId === activePerson)
      : undefined;

  return (
    <div className={styles.root} data-testid="studio-root">
      <CardinalityMarkers />

      {/*
        One boundary per view, not one around the app. A view is the largest
        region whose failure a reader can be told about while still using the
        rest, so the map failing must not cost them the toolbar, and a panel
        about one person must not cost them the map or every other person.
      */}
      <ViewBoundary view="The ontology map">
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
          onPaneClick={() => {
            setActive(null);
            setActivePerson(null);
            setActiveService(null);
            setHoverAccountId(null);
            setHoverServiceId(null);
          }}
          attributionPosition="bottom-left"
        >
          {/* No `color` prop: React Flow would take a literal, and a literal
              here is a colour living outside tokens.css. The pattern is filled
              from `--grid-dot` in that file instead. */}
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <ParticleOverlay activeEdgeIds={activeEdgeIds} />
        </ReactFlow>
      </ViewBoundary>

      {category === 'human' && viewMode === 'matrix' && helpMatrix ? (
        <ViewBoundary view="The help matrix">
          <HelpMatrix model={helpMatrix} />
        </ViewBoundary>
      ) : null}

      {category === 'agent' && fleet ? (
        <ViewBoundary view="The agent fleet">
          <FleetView snapshot={fleet} />
        </ViewBoundary>
      ) : null}

      <ViewBoundary view="The toolbar">
        <Toolbar
          category={category}
          availability={availability}
          actionCount={snapshot?.actions.length ?? 0}
          opDeclared={snapshot?.actions.filter((action) => action.op !== undefined).length ?? 0}
          onCategory={handleCategory}
          showMode={showMode}
          onShowMode={handleShowMode}
          onTidy={handleTidy}
          viewMode={viewMode}
          onViewMode={handleViewMode}
          relationship={relationship}
          onRelationship={handleRelationship}
          weightThreshold={weightThreshold}
          onWeightThresholdInc={handleWeightThresholdInc}
          onWeightThresholdDec={handleWeightThresholdDec}
        />
      </ViewBoundary>

      {/*
        Keyed by the selection: a boundary holds its failure until it unmounts,
        so without the key a second row selected after a first one failed would
        inherit the first one's fallback and read as broken until a reload.
      */}
      {category === 'db' && active && snapshot ? (
        <ViewBoundary key={`detail-${active.type}-${active.name}`} view="The detail panel">
          <DetailPanel snapshot={snapshot} focus={active} onClose={() => setActive(null)} />
        </ViewBoundary>
      ) : null}

      {category === 'human' && selectedPerson ? (
        <ViewBoundary key={`scorecard-${activePerson ?? ''}`} view="The person scorecard">
          <PersonScorecard employee={selectedPerson} onClose={() => setActivePerson(null)} />
        </ViewBoundary>
      ) : null}

      {reloadError ? (
        <div className={styles.error} data-testid="reload-error">
          Reload failed — showing the last good snapshot.
        </div>
      ) : null}
    </div>
  );
};

/**
 * Root app: the studio surface wrapped in a React Flow provider.
 *
 * The outermost boundary is the backstop for everything above the per-view ones
 * — the data fetch, the layout, and a per-view boundary that fails while
 * rendering its own message. Without it that last case would escape to React,
 * which unmounts the root, which is the failure this ticket exists to end.
 */
export const App = () => (
  <ReactFlowProvider>
    <ViewBoundary view="The studio">
      <Studio />
    </ViewBoundary>
  </ReactFlowProvider>
);
