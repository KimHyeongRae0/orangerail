import type { Category } from './instanceModel';
import styles from './CategoryTabs.module.css';

/**
 * The source-category segmented control (plan section 3.2 / Decision 2): `db`
 * renders the ONT-005 type map, `human` renders the instance graph. A category
 * with no data renders disabled so a click never lands on an empty broken view
 * (AC-4). The active tab is marked with `data-active="true"` and
 * `aria-selected="true"` (the e2e reads either).
 */
const TABS: { category: Category; label: string }[] = [
  { category: 'db', label: 'DB' },
  { category: 'human', label: 'Human' },
];

export const CategoryTabs = ({
  category,
  availability,
  onCategory,
}: {
  category: Category;
  availability: { db: boolean; human: boolean };
  onCategory: ({ category }: { category: Category }) => void;
}) => (
  <div className={styles.tabs} role="tablist" data-testid="category-tabs">
    {TABS.map((tab) => {
      const enabled = availability[tab.category];
      const active = category === tab.category;

      return (
        <button
          key={tab.category}
          type="button"
          role="tab"
          className={styles.tab}
          data-testid={`category-tab-${tab.category}`}
          data-active={active}
          aria-selected={active}
          disabled={!enabled}
          onClick={() => onCategory({ category: tab.category })}
        >
          {tab.label}
        </button>
      );
    })}
  </div>
);
