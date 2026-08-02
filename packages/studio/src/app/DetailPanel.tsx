import type { InstanceEmployee } from '../snapshot/instances';
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
 * How ONT-071 spells a value a surface could not show as it is
 * (`packages/cli/src/render.ts:102`). Reproduced here rather than imported
 * because `packages/cli` depends on this package and not the other way round;
 * `tests/e2e/ONT-072-nonconforming-row.scenario.mjs` asserts the text this panel
 * prints is byte-identical to what `/api/instances` serves for the same field,
 * so the two spellings cannot drift apart in silence.
 */
const MARKER_PREFIX = '<UNRENDERABLE — ';

/** The in-place stand-in for a value that could not be shown as it is. */
const unrenderable = ({ reason }: { reason: string }): string => `${MARKER_PREFIX}${reason}>`;

/** The marker the server already left here, or `null` when this is a real value. */
const servedMarker = ({ value }: { value: unknown }): string | null =>
  typeof value === 'string' && value.startsWith(MARKER_PREFIX) ? value : null;

/** How much of a stray string reaches a marker, so one field cannot flood the panel. */
const MAX_PREVIEW_CHARS = 40;

/** Describe a thrown value without trusting it to describe itself. */
const errorText = ({ error }: { error: unknown }): string => {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return String(error);
  } catch {
    return 'a value that cannot describe itself';
  }
};

/**
 * Name what a value IS, in ONT-071's spellings, so a reader who has seen the
 * `unrenderable` list `/api/instances` carries meets the same words here.
 */
const describeValue = ({ value }: { value: unknown }): string => {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string': {
      const clipped =
        value.length > MAX_PREVIEW_CHARS ? `${value.slice(0, MAX_PREVIEW_CHARS)}…` : value;

      return `a string (${JSON.stringify(clipped)})`;
    }
    case 'number':
      return `the number ${String(value)}`;
    case 'boolean':
      return `the boolean ${String(value)}`;
    case 'bigint':
      return `a bigint (${value.toString()})`;
    case 'symbol':
      return `a symbol (${value.toString()})`;
    case 'function':
      return `a function (${value.name === '' ? 'anonymous' : value.name})`;
    case 'undefined':
      return 'undefined';
    default:
      return Array.isArray(value) ? `an array of ${value.length} item(s)` : 'an object';
  }
};

/**
 * Why a value is not the thing the row was declared to carry.
 *
 * `undefined` and a non-finite number keep ONT-071's exact sentences
 * (`packages/cli/src/render.ts:183,191`): those are the two mismatches
 * `/api/instances` also reports, and a reader must not meet two spellings of one
 * fact. Everything else says what arrived and what was declared, in the same
 * shape.
 */
const mismatchReason = ({ value, declared }: { value: unknown; declared: string }): string => {
  if (value === undefined) {
    return 'undefined, which JSON drops key and all';
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return `the number ${String(value)}`;
  }

  return `${describeValue({ value })} where the row declares ${declared}`;
};

/** A property read: the value that was there, or the reason it could not be had. */
type FieldRead = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Read one declared field off a row.
 *
 * `InstanceEmployee` says every field is present, and that declaration is a
 * contract nothing on the read path enforces — `defineObject` stores the schema
 * and never parses `resolve` output with it
 * (`packages/core/src/define/object.ts:31-38`), so what reaches this panel is
 * whatever the datasource returned. The row is therefore read as the unknown it
 * actually is, and the property access itself is guarded: a throwing getter is
 * arbitrary user code, and before this it took the whole React root with it.
 */
const readField = ({ from, key }: { from: unknown; key: string }): FieldRead => {
  if (from === null || typeof from !== 'object') {
    return {
      ok: false,
      reason: mismatchReason({ value: from, declared: `an object carrying ${key}` }),
    };
  }

  try {
    return { ok: true, value: (from as Record<string, unknown>)[key] };
  } catch (error) {
    return { ok: false, reason: `reading it threw: ${errorText({ error })}` };
  }
};

/** What every metric field on this panel is allowed to be. */
const METRIC_DECLARED = 'a number or "unavailable"';

/** The complexity mix parts, in the order the row prints them. */
const MIX_KEYS = ['hi', 'med', 'lo'] as const;

/** What the complexity mix field is allowed to be. */
const MIX_DECLARED = 'an object with hi / med / lo';

/**
 * One metric as the panel prints it, or the reason it prints nothing.
 *
 * A number renders as its digits and the literal `'unavailable'` as that word —
 * both exactly what this panel printed before, so a conforming row is untouched
 * (AC-5). A value the server already named comes back as its own marker: naming
 * it again here would replace the server's reason with this panel's guess at
 * one, and the two surfaces would disagree about the same field.
 */
const metricRead = ({ value }: { value: unknown }): { text: string } | { reason: string } => {
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { text: String(value) }
      : { reason: mismatchReason({ value, declared: METRIC_DECLARED }) };
  }

  if (value === 'unavailable') {
    return { text: 'unavailable' };
  }

  const served = servedMarker({ value });

  return served === null
    ? { reason: mismatchReason({ value, declared: METRIC_DECLARED }) }
    : { text: served };
};

/** One metric field of a row, as its text or as the marker that names it. */
const metricText = ({ row, key }: { row: unknown; key: string }): string => {
  const read = readField({ from: row, key });

  if (!read.ok) {
    return unrenderable({ reason: read.reason });
  }

  const metric = metricRead({ value: read.value });

  return 'text' in metric ? metric.text : unrenderable({ reason: metric.reason });
};

/**
 * The complexity mix as `hi / med / lo`, or ONE marker for the whole field.
 *
 * Named once rather than as three interleaved markers: the reason says which
 * part is missing, which is the fact a reader needs, and the row stays readable.
 * The field is named, never dropped (ONT-070) — a metric that quietly vanished
 * would leave the panel claiming to be the whole of what is known about a person.
 */
const complexityMixText = ({ row }: { row: unknown }): string => {
  const read = readField({ from: row, key: 'complexityMix' });

  if (!read.ok) {
    return unrenderable({ reason: read.reason });
  }

  const mix = read.value;
  const served = servedMarker({ value: mix });

  if (served !== null) {
    return served;
  }

  if (mix === null || typeof mix !== 'object') {
    return unrenderable({ reason: mismatchReason({ value: mix, declared: MIX_DECLARED }) });
  }

  const parts: string[] = [];

  for (const key of MIX_KEYS) {
    const part = readField({ from: mix, key });
    const metric = part.ok ? metricRead({ value: part.value }) : { reason: part.reason };

    if (!('text' in metric)) {
      return unrenderable({ reason: `its ${key} is ${metric.reason}` });
    }

    parts.push(metric.text);
  }

  return parts.join(' / ');
};

/**
 * The name in the panel header.
 *
 * A row whose identity field is itself unrenderable still gets a header — the
 * marker sits where the name would have been. An untitled panel would be
 * indistinguishable from any other person's, so the one person a reader cannot
 * name is the one whose panel must say so.
 */
const displayNameText = ({ row }: { row: unknown }): string => {
  const read = readField({ from: row, key: 'displayName' });

  if (!read.ok) {
    return unrenderable({ reason: read.reason });
  }

  return typeof read.value === 'string'
    ? read.value
    : unrenderable({ reason: mismatchReason({ value: read.value, declared: 'a string' }) });
};

/**
 * One labelled metric row: the metric value plus its static derivation note.
 * A marker carries `data-unrenderable` so the styling — and a test — can tell a
 * named absence from a value that happens to read like one.
 */
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
    <span
      className={styles.rowValue}
      data-unrenderable={value.startsWith(MARKER_PREFIX) ? 'true' : undefined}
    >
      {value}
    </span>
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
}) => {
  // Read as `unknown`, deliberately. The type is the declaration, not a promise
  // the row kept — see `readField`. Every field below therefore goes through a
  // reader that returns text or a marker, never a deref that can throw.
  const row: unknown = employee;
  const name = displayNameText({ row });

  return (
    <aside className={styles.panel} data-testid="scorecard">
      <div className={styles.header}>
        <span className={styles.title} title={name}>
          {name}
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
          value={metricText({ row, key: 'ticketCount' })}
          derivation="Assigned issues in the export window."
        />
        <MetricRow
          label="Story points"
          value={metricText({ row, key: 'storyPointsTotal' })}
          derivation="Sum of story points across assigned issues."
        />
        <MetricRow
          label="Complexity mix (hi/med/lo)"
          value={complexityMixText({ row })}
          derivation="Assigned issues bucketed by story points."
        />
        <MetricRow
          label="Median cycle days (first half)"
          value={metricText({ row, key: 'medianCycleDaysFirstHalf' })}
          derivation="Median created-to-resolved days, first half of the window."
        />
        <MetricRow
          label="Median cycle days (second half)"
          value={metricText({ row, key: 'medianCycleDaysSecondHalf' })}
          derivation="Median created-to-resolved days, second half of the window."
        />
        <MetricRow
          label="Reopen rate"
          value={metricText({ row, key: 'reopenRate' })}
          derivation="Percent of assigned issues with a reopen transition."
        />
        <MetricRow
          label="Reassignments given"
          value={metricText({ row, key: 'reassignmentsGiven' })}
          derivation="Issues this person reassigned away."
        />
        <MetricRow
          label="Reassignments received"
          value={metricText({ row, key: 'reassignmentsReceived' })}
          derivation="Issues reassigned onto this person."
        />
        <MetricRow
          label="Help given"
          value={metricText({ row, key: 'helpGiven' })}
          derivation="Out-degree in the Slack help graph."
        />
        <MetricRow
          label="Help received"
          value={metricText({ row, key: 'helpReceived' })}
          derivation="In-degree in the Slack help graph."
        />
        <MetricRow
          label="Weekend / off-hours share"
          value={metricText({ row, key: 'weekendOffHoursShare' })}
          derivation="Percent of activity outside standard hours."
        />
      </section>
    </aside>
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
