import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { PlaceNode as PlaceNodeType } from '../instanceModel';
import styles from './ServiceNode.module.css';

/**
 * A place instance node: a service or the team hub, rendered as a squared tag
 * (visually distinct from the person circle — plan section 3.3). Services carry
 * `data-instance-kind="service"` (the counting hook) plus inert `busFactor` /
 * `ticketCount` sublabels; the team renders as one light structural hub. All
 * labels render as React text only (AC-6).
 */
export const ServiceNode = ({ data }: NodeProps<PlaceNodeType>) => {
  const { kind, label, service, active, dim } = data;

  return (
    <div
      className={styles.place}
      data-instance-kind={kind}
      data-place-kind={kind}
      data-active={active === true}
      data-dim={dim === true}
    >
      <Handle type="target" position={Position.Left} className={styles.handle} />

      <span className={styles.kind}>{kind}</span>
      <span className={styles.label} title={label}>
        {label}
      </span>

      {kind === 'service' && service ? (
        <span className={styles.meta}>
          bus factor {service.busFactor} · {service.ticketCount} tickets
        </span>
      ) : null}

      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  );
};
