import { useState } from 'react';

import { cellKey, type HelpMatrixModel } from './helpMatrix';
import styles from './HelpMatrixView.module.css';

/**
 * The person x person `helps` adjacency matrix (plan Decision 3, AC-3). A plain
 * DOM grid — NOT React Flow — so it is crossing-free by construction: a top
 * header row of column labels, a left column of row labels, and a cell per
 * (row -> col) help pair whose background opacity scales with `weight /
 * maxWeight` (intensity encodes weight). Rows are degree-ordered so a help hub
 * reads as a dense row/column near the top-left. Hovering a row or a cell marks
 * the affected row/column with `data-hover="true"` (a CSS accent), matching the
 * studio's data-attribute CSS-gate idiom. Every label and header is a React
 * text node (`{displayName}`) — never `dangerouslySetInnerHTML` — so a hostile
 * `displayName` renders inert (AC-5). No composite score, no ranking number:
 * raw weights and their intensity only (honesty).
 */
export const HelpMatrix = ({ model }: { model: HelpMatrixModel }) => {
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [hoveredCol, setHoveredCol] = useState<string | null>(null);

  const { order, labels, weights, maxWeight } = model;

  return (
    <div className={styles.matrix} data-testid="help-matrix">
      <div className={styles.scroll}>
        <div className={styles.headerRow}>
          <div className={styles.corner}>helps →</div>

          {order.map((col) => (
            <div
              key={col}
              className={styles.colHeader}
              data-testid="matrix-col-header"
              data-account-id={col}
              data-hover={hoveredCol === col}
              onMouseOver={(event) => {
                // Bridge: set the attribute synchronously (mouseover is a
                // continuous-priority React event and does not flush the state
                // re-render before a synchronous DOM read), then update state
                // for the cross-highlight. React reconciles to the same value.
                event.currentTarget.setAttribute('data-hover', 'true');
                setHoveredCol(col);
              }}
              title={labels.get(col)}
            >
              <span className={styles.colHeaderLabel}>{labels.get(col)}</span>
            </div>
          ))}
        </div>

        {order.map((row) => (
          <div
            key={row}
            className={styles.row}
            data-testid="matrix-row"
            data-account-id={row}
            data-hover={hoveredRow === row}
            onMouseOver={(event) => {
              event.currentTarget.setAttribute('data-hover', 'true');
              setHoveredRow(row);
            }}
          >
            <div className={styles.rowHeader} title={labels.get(row)}>
              {labels.get(row)}
            </div>

            {order.map((col) => {
              const weight = weights.get(cellKey({ from: row, to: col })) ?? 0;
              const intensity = maxWeight > 0 ? weight / maxWeight : 0;

              return (
                <div
                  key={col}
                  className={styles.cell}
                  data-testid="matrix-cell"
                  data-from={row}
                  data-to={col}
                  data-weight={weight}
                  data-hover={hoveredRow === row || hoveredCol === col}
                  onMouseOver={() => {
                    setHoveredRow(row);
                    setHoveredCol(col);
                  }}
                  style={{ backgroundColor: `rgba(29, 237, 131, ${intensity})` }}
                >
                  {weight > 0 ? <span className={styles.cellWeight}>{weight}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
