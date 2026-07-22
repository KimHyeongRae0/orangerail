import type { GraphSnapshot } from '../snapshot/types';
import type { Focus } from './highlight';
import styles from './DetailPanel.module.css';

/**
 * The right-docked detail panel (modelled on Liam's, content-minimal). On an
 * object selection it lists the object's fields with full types, its links, and
 * its actions; on an action selection it shows the full policy detail. Every
 * value renders as text (AC-8). It closes on pane click (handled by App), so it
 * never blocks canvas interaction for testing.
 */
const ObjectDetail = ({ snapshot, name }: { snapshot: GraphSnapshot; name: string }) => {
  const object = snapshot.objects.find((o) => o.name === name);

  if (!object) {
    return <p className={styles.muted}>Object not found.</p>;
  }

  const links = snapshot.links.filter((l) => l.from === name || l.to === name);
  const actions = snapshot.actions.filter((a) => a.target === name);

  return (
    <>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Fields</h3>
        {object.fields.length === 0 ? <p className={styles.muted}>No fields.</p> : null}
        {object.fields.map((field) => (
          <div key={field.name} className={styles.row}>
            <span className={styles.rowKey} title={field.name}>
              {field.name}
              {field.optional ? '?' : ''}
            </span>
            <span className={styles.rowValue}>{field.type}</span>
          </div>
        ))}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Access</h3>
        <div className={styles.row}>
          <span className={styles.rowKey}>readAccess</span>
          <span className={styles.rowValue}>{object.readAccess}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.rowKey}>resolve</span>
          <span className={styles.rowValue}>{object.hasResolve ? 'yes' : 'none'}</span>
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Links</h3>
        {links.length === 0 ? <p className={styles.muted}>No links.</p> : null}
        {links.map((link) => (
          <div key={link.id} className={styles.row}>
            <span className={styles.rowKey}>
              {link.from === name ? `→ ${link.to}` : `← ${link.from}`}
            </span>
            <span className={styles.rowValue}>{link.cardinality}</span>
          </div>
        ))}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Actions</h3>
        {actions.length === 0 ? <p className={styles.muted}>No actions.</p> : null}
        {actions.map((action) => (
          <div key={action.name} className={styles.row}>
            <span className={styles.rowKey}>{action.name}</span>
            <span className={styles.rowValue}>{action.approval}</span>
          </div>
        ))}
      </section>
    </>
  );
};

const ActionDetail = ({ snapshot, name }: { snapshot: GraphSnapshot; name: string }) => {
  const action = snapshot.actions.find((a) => a.name === name);

  if (!action) {
    return <p className={styles.muted}>Action not found.</p>;
  }

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Policy</h3>
      <div className={styles.row}>
        <span className={styles.rowKey}>target</span>
        <span className={styles.rowValue}>{action.target ?? 'none'}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowKey}>approval</span>
        <span className={styles.rowValue}>{action.approval}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowKey}>approvers</span>
        <span className={styles.rowValue}>
          {action.roles.length > 0 ? action.roles.join(', ') : 'any'}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowKey}>condition</span>
        <span className={styles.rowValue}>
          {action.where === 'declarative' ? action.whereText : action.where}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowKey}>implemented</span>
        <span className={styles.rowValue}>{action.notImplemented ? 'no (stub)' : 'yes'}</span>
      </div>
    </section>
  );
};

export const DetailPanel = ({
  snapshot,
  focus,
  onClose,
}: {
  snapshot: GraphSnapshot;
  focus: NonNullable<Focus>;
  onClose: () => void;
}) => (
  <aside className={styles.panel} data-testid="detail-panel">
    <div className={styles.header}>
      <span className={styles.title} title={focus.name}>
        {focus.name}
      </span>
      <button
        type="button"
        className={styles.close}
        data-testid="panel-close"
        aria-label="Close panel"
        onClick={onClose}
      >
        ×
      </button>
    </div>

    {focus.type === 'object' ? (
      <ObjectDetail snapshot={snapshot} name={focus.name} />
    ) : (
      <ActionDetail snapshot={snapshot} name={focus.name} />
    )}
  </aside>
);
