import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { PersonNode as PersonNodeType } from '../instanceModel';
import styles from './PersonNode.module.css';

/**
 * A person instance node: a circle sized by `storyPointsTotal` (plan section
 * 3.3), labelled with the person's `displayName`. Inactive employees render
 * muted but present. The `displayName` renders as a React text node only — no
 * `dangerouslySetInnerHTML` anywhere — so a hostile name is inert (AC-6). The
 * `data-instance-kind="person"` attribute is the selection/counting hook; a
 * click bubbles to React Flow's `onNodeClick`, which opens the scorecard.
 */
export const PersonNode = ({ data }: NodeProps<PersonNodeType>) => {
  const { employee, radius, active } = data;
  const diameter = radius * 2;

  return (
    <div
      className={styles.person}
      data-instance-kind="person"
      data-account-id={employee.accountId}
      data-active={active}
      data-inactive={!employee.active}
      style={{ width: diameter, height: diameter }}
    >
      <Handle type="target" position={Position.Left} className={styles.handle} />

      <span className={styles.label} title={employee.displayName}>
        {employee.displayName}
      </span>

      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  );
};
