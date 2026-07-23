import type { ViewMode } from './instanceModel';
import styles from './ViewTabs.module.css';

/**
 * The human-category view switcher (plan section 3.1, AC-1): Network / Matrix /
 * Ownership. Modelled on `CategoryTabs` — a `role="tablist"` of `role="tab"`
 * buttons, each carrying `data-active` / `aria-selected` and a per-tab
 * `data-testid` (`view-tab-network|matrix|ownership`) the e2e reads. Only shown
 * for the human category; the db category never renders it.
 */
const TABS: { view: ViewMode; label: string }[] = [
  { view: 'network', label: 'Network' },
  { view: 'matrix', label: 'Matrix' },
  { view: 'ownership', label: 'Ownership' },
];

export const ViewTabs = ({
  viewMode,
  onViewMode,
}: {
  viewMode: ViewMode;
  onViewMode: ({ view }: { view: ViewMode }) => void;
}) => (
  <div className={styles.tabs} role="tablist" data-testid="view-tabs">
    {TABS.map((tab) => {
      const active = viewMode === tab.view;

      return (
        <button
          key={tab.view}
          type="button"
          role="tab"
          className={styles.tab}
          data-testid={`view-tab-${tab.view}`}
          data-active={active}
          aria-selected={active}
          onClick={() => onViewMode({ view: tab.view })}
        >
          {tab.label}
        </button>
      );
    })}
  </div>
);
