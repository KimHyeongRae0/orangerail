import type { AgentFleetSnapshot } from '../snapshot';
import styles from './FleetView.module.css';

/**
 * The agent-fleet governance readout — a plain DOM overlay (NOT React Flow, like
 * the Matrix view) that surfaces the derived findings from `AgentFleetSnapshot`:
 * ungated destructive actions, per-agent direct-vs-effective blast radius,
 * authority overlaps, delegation cycles, and recursive spawners. Every value is
 * a straight read of the deterministic snapshot — no composite score and no
 * ranking number (the same honesty posture as the Matrix / person scorecard);
 * the blast-radius rows are ordered by effective reach only to put the widest
 * authority on top. All labels render as React text nodes — a hostile agent id
 * or object name is inert.
 */
export const FleetView = ({ snapshot }: { snapshot: AgentFleetSnapshot }) => {
  const blastRadius = [...snapshot.blastRadius].sort(
    (a, b) =>
      b.effectiveObjects.length - a.effectiveObjects.length ||
      b.effectiveActions - a.effectiveActions ||
      a.agentId.localeCompare(b.agentId),
  );

  const maxEffective = blastRadius.reduce(
    (max, row) => Math.max(max, row.effectiveObjects.length),
    0,
  );

  return (
    <div className={styles.fleet} data-testid="fleet-view">
      <div className={styles.scroll}>
        <header className={styles.head}>
          <h1 className={styles.title}>Agent fleet governance</h1>
          <p className={styles.subtitle}>
            {snapshot.agentCount} agent{snapshot.agentCount === 1 ? '' : 's'} · derived from
            declared actions, approval policies, and delegation edges. Counts only — no score.
          </p>
        </header>

        {snapshot.ungatedDestructiveActions.length > 0 ? (
          <section className={styles.section} data-testid="fleet-ungated">
            <h2 className={styles.sectionTitle}>
              <span className={styles.alertDot} /> Ungated destructive actions
            </h2>
            <p className={styles.note}>A delete that runs with no approval on the rail.</p>
            <div className={styles.cards}>
              {snapshot.ungatedDestructiveActions.map((row) => (
                <div
                  key={`${row.agentId}:${row.action}`}
                  className={styles.alertCard}
                  data-testid="fleet-ungated-row"
                >
                  <span className={styles.agentId}>{row.agentId}</span>
                  <span className={styles.actionName}>{row.action}</span>
                  <span className={styles.arrow}>deletes</span>
                  <span className={styles.objectName}>{row.object}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className={styles.section} data-testid="fleet-blast">
          <h2 className={styles.sectionTitle}>Blast radius — direct vs effective</h2>
          <p className={styles.note}>
            How many objects an agent writes itself, versus everything it can reach through the
            agents it delegates to and spawns.
          </p>
          <div className={styles.table}>
            {blastRadius.map((row) => {
              const width =
                maxEffective > 0 ? (row.effectiveObjects.length / maxEffective) * 100 : 0;
              const directWidth =
                maxEffective > 0 ? (row.directObjects.length / maxEffective) * 100 : 0;
              const diverges = row.effectiveObjects.length > row.directObjects.length;

              return (
                <div
                  className={styles.row}
                  data-testid="fleet-blast-row"
                  data-agent-id={row.agentId}
                  key={row.agentId}
                >
                  <div className={styles.rowHead}>
                    <span className={styles.agentId}>{row.agentId}</span>
                    {row.unbounded ? (
                      <span className={styles.badgeUnbounded} title="Reaches a recursive spawner">
                        unbounded
                      </span>
                    ) : null}
                    {row.destructiveObjects.length > 0 ? (
                      <span className={styles.badgeDestructive}>
                        {row.destructiveObjects.length} destructive
                      </span>
                    ) : null}
                  </div>
                  <div className={styles.bar}>
                    <div
                      className={diverges ? styles.barEffectiveWide : styles.barEffective}
                      style={{ width: `${width}%` }}
                    />
                    <div className={styles.barDirect} style={{ width: `${directWidth}%` }} />
                  </div>
                  <div className={styles.rowMeta}>
                    <span className={styles.direct}>{row.directObjects.length} direct</span>
                    <span className={styles.arrow}>→</span>
                    <span className={diverges ? styles.effectiveWide : styles.effective}>
                      {row.effectiveObjects.length} effective
                    </span>
                    {row.reachableAgents.length > 0 ? (
                      <span className={styles.via}>via {row.reachableAgents.length} agents</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {snapshot.authorityOverlaps.length > 0 ? (
          <section className={styles.section} data-testid="fleet-overlaps">
            <h2 className={styles.sectionTitle}>Authority overlaps</h2>
            <p className={styles.note}>
              The same action on the same object, held by more than one agent — split accountability
              with no interlock.
            </p>
            <div className={styles.cards}>
              {snapshot.authorityOverlaps.map((row) => (
                <div
                  className={styles.card}
                  data-testid="fleet-overlap-row"
                  key={`${row.action}:${row.object}`}
                >
                  <span className={styles.actionName}>{row.action}</span>
                  <span className={styles.arrow}>on</span>
                  <span className={styles.objectName}>{row.object}</span>
                  <span className={styles.agents}>
                    {row.agents.map((id) => (
                      <span className={styles.chip} key={id}>
                        {id}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {snapshot.delegationCycles.length > 0 ? (
          <section className={styles.section} data-testid="fleet-cycles">
            <h2 className={styles.sectionTitle}>Delegation cycles</h2>
            <p className={styles.note}>Agents that delegate back to one another.</p>
            <div className={styles.cards}>
              {snapshot.delegationCycles.map((cycle) => (
                <div
                  className={styles.card}
                  data-testid="fleet-cycle-row"
                  key={cycle.agents.join('|')}
                >
                  {cycle.agents.map((id, index) => (
                    <span className={styles.cycleMember} key={id}>
                      {index > 0 ? <span className={styles.arrow}>⇄</span> : null}
                      <span className={styles.chip}>{id}</span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {snapshot.recursiveSpawners.length > 0 ? (
          <section className={styles.section} data-testid="fleet-spawners">
            <h2 className={styles.sectionTitle}>Recursive spawners</h2>
            <p className={styles.note}>
              Agents that spawn sub-agents at run time. The children below are a representative
              expansion — the live count is unbounded.
            </p>
            <div className={styles.cards}>
              {snapshot.recursiveSpawners.map((row) => (
                <div className={styles.card} data-testid="fleet-spawner-row" key={row.agentId}>
                  <span className={styles.agentId}>{row.agentId}</span>
                  <span className={styles.arrow}>spawns</span>
                  <span className={styles.template}>{row.template}</span>
                  {row.spawnedChildren.length > 0 ? (
                    <span className={styles.agents}>
                      {row.spawnedChildren.map((id) => (
                        <span className={styles.chip} key={id}>
                          {id}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
};
