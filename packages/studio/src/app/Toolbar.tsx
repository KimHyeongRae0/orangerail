import { useReactFlow, useStore } from '@xyflow/react';
import type { ChangeEvent } from 'react';

import { CategoryTabs } from './CategoryTabs';
import { fitAll } from './fit';
import type { Category } from './instanceModel';
import type { ShowMode, StudioEdge, StudioNode } from './model';
import styles from './Toolbar.module.css';

/**
 * The bottom-centre toolbar. It always hosts the source-category tabs (db /
 * human — plan section 3.2). The zoom / fit / tidy cluster is shared. The
 * remaining controls are category-scoped: the db view shows the show-mode
 * dropdown (All Fields / Name Only), the human view shows the `works_on` edge
 * toggle. No minimap (the reference has none).
 */
export const Toolbar = ({
  category,
  availability,
  onCategory,
  showMode,
  onShowMode,
  onTidy,
  showWorksOn,
  onToggleWorksOn,
}: {
  category: Category;
  availability: { db: boolean; human: boolean };
  onCategory: ({ category }: { category: Category }) => void;
  showMode: ShowMode;
  onShowMode: ({ mode }: { mode: ShowMode }) => void;
  onTidy: () => void;
  showWorksOn: boolean;
  onToggleWorksOn: () => void;
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
        <button
          type="button"
          className={styles.button}
          data-testid="toggle-works-on"
          aria-label="Toggle works-on edges"
          aria-pressed={showWorksOn}
          data-active={showWorksOn}
          onClick={onToggleWorksOn}
        >
          works_on {showWorksOn ? 'on' : 'off'}
        </button>
      ) : (
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
      )}
    </div>
  );
};
