import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { SnapshotField } from '../../snapshot/types';
import type { ObjectNode } from '../model';
import { DiamondFilled, DiamondOutline, LinkGlyph, TableGlyph } from './icons';
import styles from './ObjectCard.module.css';

/**
 * A schema-card node: header (table glyph + object name) plus one row per
 * top-level field with a shape-not-colour marker, the field name, and the
 * field type in monospace. The type text is always in the DOM but CSS-gated to
 * `opacity: 0` until the card is highlighted/active (Liam's exact reveal
 * mechanism, driven by the `data-erd` attribute). All user strings render as
 * React text nodes only — no `dangerouslySetInnerHTML` anywhere (AC-8).
 */
const fieldMarker = ({ field }: { field: SnapshotField }) => {
  if (field.inLink) {
    return <LinkGlyph />;
  }

  return field.optional ? <DiamondOutline /> : <DiamondFilled />;
};

export const ObjectCard = ({ data }: NodeProps<ObjectNode>) => {
  const { object, showMode, active, highlighted, dim } = data;
  const revealed = active || highlighted;

  return (
    <div
      className={styles.card}
      data-testid="object-node"
      data-object-name={object.name}
      data-active={active}
      data-highlighted={highlighted}
      data-dim={dim}
      data-erd={revealed ? 'highlighted' : 'resting'}
    >
      <Handle type="target" position={Position.Left} id="tgt" className={styles.handle} />

      <div className={styles.header}>
        <span className={styles.headerIcon}>
          <TableGlyph />
        </span>
        <span className={styles.name} title={object.name}>
          {object.name}
        </span>
      </div>

      {showMode === 'all' && object.fields.length > 0 ? (
        <ul className={styles.fields}>
          {object.fields.map((field) => (
            <li
              key={field.name}
              className={styles.row}
              data-testid="field-row"
              data-field-name={field.name}
            >
              <span className={styles.rowIcon} data-accent={field.inLink}>
                {fieldMarker({ field })}
              </span>
              <span className={styles.fieldName} title={field.name}>
                {field.name}
              </span>
              <span className={styles.fieldType}>{field.type}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Handle type="source" position={Position.Right} id="src" className={styles.handle} />
      <Handle type="target" position={Position.Right} id="loop" className={styles.handle} />
    </div>
  );
};
