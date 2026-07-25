import { useReactFlow, useStore } from '@xyflow/react';
import type { ChangeEvent } from 'react';

import { CategoryTabs } from './CategoryTabs';
import { fitAll } from './fit';
import type { Category, Relationship, ViewMode } from './instanceModel';
import type { ShowMode, StudioEdge, StudioNode } from './model';
import { ViewTabs } from './ViewTabs';
import styles from './Toolbar.module.css';

const RELATIONSHIPS: { relationship: Relationship; label: string }[] = [
  { relationship: 'helps', label: 'helps' },
  { relationship: 'works_on', label: 'works_on' },
  { relationship: 'member_of', label: 'member_of' },
];

/**
 * The bottom-centre toolbar. It always hosts the source-category tabs (db /
 * human — plan section 3.2). The zoom / fit / tidy cluster is shared. The
 * remaining controls are category-scoped: the db view shows the show-mode
 * dropdown (All Fields / Name Only); the human view shows the view switcher
 * (Network / Matrix / Ownership) plus, in the Network view, a single-select
 * relationship control and an edge-weight-threshold stepper (plan section
 * 3.1-3.2). No minimap (the reference has none).
 */
export const Toolbar = ({
  category,
  availability,
  onCategory,
  showMode,
  onShowMode,
  onTidy,
  viewMode,
  onViewMode,
  relationship,
  onRelationship,
  weightThreshold,
  onWeightThresholdInc,
  onWeightThresholdDec,
}: {
  category: Category;
  availability: { db: boolean; human: boolean; agent: boolean };
  onCategory: ({ category }: { category: Category }) => void;
  showMode: ShowMode;
  onShowMode: ({ mode }: { mode: ShowMode }) => void;
  onTidy: () => void;
  viewMode: ViewMode;
  onViewMode: ({ view }: { view: ViewMode }) => void;
  relationship: Relationship;
  onRelationship: ({ relationship }: { relationship: Relationship }) => void;
  weightThreshold: number;
  onWeightThresholdInc: () => void;
  onWeightThresholdDec: () => void;
}) => {
  const rf = useReactFlow<StudioNode, StudioEdge>();
  const zoom = useStore((state) => state.transform[2]);
  const percentage = `${Math.round(zoom * 100)}%`;

  const handleShowMode = (event: ChangeEvent<HTMLSelectElement>) => {
    onShowMode({ mode: event.target.value === 'name' ? 'name' : 'all' });
  };

  return (
    <div className={styles.toolbar} data-testid="toolbar">
      <CategoryTabs category={category} availability={availability} onCategory={onCategory} />

      <span className={styles.divider} />

      <button
        type="button"
        className={styles.button}
        data-testid="zoom-out"
        aria-label="Zoom out"
        onClick={() => rf.zoomOut()}
      >
        −
      </button>
      <span className={styles.level} data-testid="zoom-level">
        {percentage}
      </span>
      <button
        type="button"
        className={styles.button}
        data-testid="zoom-in"
        aria-label="Zoom in"
        onClick={() => rf.zoomIn()}
      >
        +
      </button>

      <span className={styles.divider} />

      <button
        type="button"
        className={styles.button}
        data-testid="fit"
        aria-label="Fit to content"
        onClick={() => fitAll({ rf, duration: 200 })}
      >
        ⤢
      </button>
      <button
        type="button"
        className={styles.button}
        data-testid="tidy"
        aria-label="Tidy up"
        onClick={onTidy}
      >
        ▦
      </button>

      <span className={styles.divider} />

      {category === 'human' ? (
        <>
          <ViewTabs viewMode={viewMode} onViewMode={onViewMode} />

          {viewMode === 'network' ? (
            <>
              <span className={styles.divider} />

              <div className={styles.segmented} role="tablist" data-testid="relationship-tabs">
                {RELATIONSHIPS.map((item) => {
                  const active = relationship === item.relationship;

                  return (
                    <button
                      key={item.relationship}
                      type="button"
                      role="tab"
                      className={styles.segment}
                      data-testid={`relationship-tab-${item.relationship}`}
                      data-active={active}
                      aria-selected={active}
                      onClick={() => onRelationship({ relationship: item.relationship })}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              <span className={styles.divider} />

              <div className={styles.stepper} data-testid="weight-threshold">
                <button
                  type="button"
                  className={styles.button}
                  data-testid="weight-threshold-dec"
                  aria-label="Lower the edge-weight threshold"
                  onClick={onWeightThresholdDec}
                >
                  −
                </button>
                <span className={styles.level} data-testid="weight-threshold-value">
                  ≥ {weightThreshold}
                </span>
                <button
                  type="button"
                  className={styles.button}
                  data-testid="weight-threshold-inc"
                  aria-label="Raise the edge-weight threshold"
                  onClick={onWeightThresholdInc}
                >
                  +
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : category === 'db' ? (
        <>
          <span className={styles.label}>show</span>
          <select
            className={styles.select}
            data-testid="show-mode"
            aria-label="Show mode"
            value={showMode}
            onChange={handleShowMode}
          >
            <option value="all">All Fields</option>
            <option value="name">Name Only</option>
          </select>
        </>
      ) : null}
    </div>
  );
};
