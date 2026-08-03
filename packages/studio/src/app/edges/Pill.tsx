import type { MouseEvent } from 'react';

import type { SnapshotAction } from '../../snapshot/types';
import { HOVER_ACTION_EVENT, SELECT_ACTION_EVENT } from '../model';
import { BoltGlyph, LockGlyph } from '../nodes/icons';
import styles from './Pill.module.css';

/**
 * The action pill — Stately's edge-label grammar recoloured to the Liam palette
 * (plan section 3.3): the action name as the primary label, a subordinate
 * policy chip below it (a lock + `approval` (+ roles) for governed actions, a
 * bolt + `auto` for ungoverned ones), the declarative `where` fused inline as a
 * dimmed guard segment (`only when …`), a `condition: code` marker for a
 * functional `where`, and a distinct muted `stub` chip for not-implemented
 * actions. Clicking dispatches one window event so selection is uniform whether
 * the pill sits on an edge label or a node. All strings render as text (AC-8).
 */
export const Pill = ({
  action,
  active,
  highlighted,
  dim,
}: {
  action: SnapshotAction;
  active: boolean;
  highlighted: boolean;
  dim: boolean;
}) => {
  const governed = action.approval === 'required';

  const select = (event: MouseEvent) => {
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent(SELECT_ACTION_EVENT, { detail: action.name }));
  };

  const hover = (name: string | null) => {
    window.dispatchEvent(new CustomEvent(HOVER_ACTION_EVENT, { detail: name }));
  };

  // Ignore a phantom leave (cursor still within the pill after a DOM re-attach)
  // so it cannot sustain a hover oscillation, mirroring the object-card guard.
  const leave = (event: MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;

    if (!inside) {
      hover(null);
    }
  };

  return (
    <div
      className={styles.pill}
      data-testid="action-node"
      data-action-name={action.name}
      data-active={active}
      data-highlighted={highlighted}
      data-dim={dim}
      onClick={select}
      onMouseEnter={() => hover(action.name)}
      onMouseLeave={leave}
    >
      <span className={styles.name} title={action.name}>
        {action.name}
      </span>

      <div className={styles.chips}>
        {governed ? (
          <span className={styles.chip} data-gated="true">
            <LockGlyph />
            approval{action.roles.length > 0 ? ` · ${action.roles.join(', ')}` : ''}
          </span>
        ) : (
          <span className={styles.chip} data-auto="true">
            <BoltGlyph />
            auto
          </span>
        )}

        {action.where === 'declarative' ? (
          <span className={styles.guard}>only when {action.whereText}</span>
        ) : null}

        {action.where === 'functional' ? (
          <span className={styles.guard}>condition: code</span>
        ) : null}

        {action.notImplemented ? <span className={styles.stub}>stub</span> : null}
      </div>
    </div>
  );
};
