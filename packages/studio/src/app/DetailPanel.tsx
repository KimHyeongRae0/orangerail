import type { InstanceEmployee, MetricValue } from '../snapshot/instances';
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

/**
 * Render a metric value verbatim: a number as its string, the literal
 * `'unavailable'` as the word `unavailable` — never coerced to `0` or blank
 * (plan section 3.3 edge case, honesty contract).
 */
const metricText = ({ value }: { value: MetricValue }): string =>
  typeof value === 'number' ? String(value) : value;

/** One labelled metric row: the metric value plus its static derivation note. */
const MetricRow = ({
  label,
  value,
  derivation,
}: {
  label: string;
  value: string;
  derivation: string;
}) => (
  <div className={styles.row}>
    <span className={styles.rowKey} title={derivation}>
      {label}
    </span>
    <span className={styles.rowValue}>{value}</span>
  </div>
);

/**
 * The person scorecard (plan section 3.3, Decision 3 — honesty-in-UI). It lists
 * the ONT-010 evidence-backed metrics with each metric's name and a static
 * derivation note (title attribute). There is deliberately NO composite score,
 * NO ranking number, and NO `[data-testid="rank"]` element anywhere — the panel
 * shows raw evidence only (AC-3). The `displayName` and every value render as
 * React text; a hostile name stays inert (AC-6).
 */
export const PersonScorecard = ({
  employee,
  onClose,
}: {
  employee: InstanceEmployee;
  onClose: () => void;
}) => (
  <aside className={styles.panel} data-testid="scorecard">
    <div className={styles.header}>
      <span className={styles.title} title={employee.displayName}>
        {employee.displayName}
      </span>
      <button
        type="button"
        className={styles.close}
        data-testid="scorecard-close"
        aria-label="Close scorecard"
        onClick={onClose}
      >
        ×
      </button>
    </div>

    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Evidence metrics</h3>

      <MetricRow
        label="Ticket count"
        value={String(employee.ticketCount)}
        derivation="Assigned issues in the export window."
      />
      <MetricRow
        label="Story points"
        value={String(employee.storyPointsTotal)}
        derivation="Sum of story points across assigned issues."
      />
      <MetricRow
        label="Complexity mix (hi/med/lo)"
        value={`${employee.complexityMix.hi} / ${employee.complexityMix.med} / ${employee.complexityMix.lo}`}
        derivation="Assigned issues bucketed by story points."
      />
      <MetricRow
        label="Median cycle days (first half)"
        value={metricText({ value: employee.medianCycleDaysFirstHalf })}
        derivation="Median created-to-resolved days, first half of the window."
      />
      <MetricRow
        label="Median cycle days (second half)"
        value={metricText({ value: employee.medianCycleDaysSecondHalf })}
        derivation="Median created-to-resolved days, second half of the window."
      />
      <MetricRow
        label="Reopen rate"
        value={metricText({ value: employee.reopenRate })}
        derivation="Percent of assigned issues with a reopen transition."
      />
      <MetricRow
        label="Reassignments given"
        value={metricText({ value: employee.reassignmentsGiven })}
        derivation="Issues this person reassigned away."
      />
      <MetricRow
        label="Reassignments received"
        value={metricText({ value: employee.reassignmentsReceived })}
        derivation="Issues reassigned onto this person."
      />
      <MetricRow
        label="Help given"
        value={String(employee.helpGiven)}
        derivation="Out-degree in the Slack help graph."
      />
      <MetricRow
        label="Help received"
        value={String(employee.helpReceived)}
        derivation="In-degree in the Slack help graph."
      />
      <MetricRow
        label="Weekend / off-hours share"
        value={metricText({ value: employee.weekendOffHoursShare })}
        derivation="Percent of activity outside standard hours."
      />
    </section>
  </aside>
);

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
