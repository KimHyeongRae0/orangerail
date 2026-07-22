import { useReactFlow, useStore } from '@xyflow/react';
import type { ChangeEvent } from 'react';

import { fitAll } from './fit';
import type { ShowMode, StudioEdge, StudioNode } from './model';
import styles from './Toolbar.module.css';

/**
 * The bottom-centre toolbar (Liam's set minus what the ontology lacks): zoom
 * out / live percentage / zoom in, fit-to-content, tidy-up (re-run layout), and
 * a show-mode dropdown with All Fields / Name Only (Liam's Key Only is dropped —
 * the ontology has no primary-key concept). No minimap (the reference has none).
 */
export const Toolbar = ({
  showMode,
  onShowMode,
  onTidy,
}: {
  showMode: ShowMode;
  onShowMode: ({ mode }: { mode: ShowMode }) => void;
  onTidy: () => void;
}) => {
  const rf = useReactFlow<StudioNode, StudioEdge>();
  const zoom = useStore((state) => state.transform[2]);
  const percentage = `${Math.round(zoom * 100)}%`;

  const handleShowMode = (event: ChangeEvent<HTMLSelectElement>) => {
    onShowMode({ mode: event.target.value === 'name' ? 'name' : 'all' });
  };

  return (
    <div className={styles.toolbar} data-testid="toolbar">
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
    </div>
  );
};
