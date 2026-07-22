import type { GraphSnapshot } from '../snapshot/types';
import styles from './EmptyState.module.css';

/** Whether a snapshot declares nothing to render (ticket edge case). */
export const isEmptySnapshot = ({ snapshot }: { snapshot: GraphSnapshot }): boolean =>
  snapshot.objects.length === 0 && snapshot.actions.length === 0;

/**
 * The explicit empty state for an ontology with no objects and no actions — a
 * coherent message on the canvas rather than a blank canvas or a crash.
 */
export const EmptyState = () => (
  <div className={styles.empty} data-testid="empty-state">
    <p className={styles.title}>No ontology to map</p>
    <p className={styles.hint}>
      This configuration declares no object types and no action types. Declare some with
      defineObject / defineAction and the map will appear here.
    </p>
  </div>
);
