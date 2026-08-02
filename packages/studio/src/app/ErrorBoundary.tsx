import { Component, type ErrorInfo, type ReactNode } from 'react';

import styles from './ErrorBoundary.module.css';

/**
 * Describe a thrown value without trusting it to describe itself.
 *
 * This is the one component with nothing below it to catch a mistake: reading
 * `.message` off an arbitrary thrown object is arbitrary user code, and a throw
 * here would escape to the parent boundary and turn a failed view into a failed
 * application.
 */
const thrownText = ({ error }: { error: unknown }): string => {
  try {
    if (error instanceof Error && typeof error.message === 'string') {
      return error.message;
    }

    return String(error);
  } catch {
    return 'an error that cannot describe itself';
  }
};

interface ViewBoundaryProps {
  /** The view this boundary owns, named as the subject of the failure sentence. */
  view: string;
  children: ReactNode;
}

interface ViewBoundaryState {
  /** The reason the view failed, or `null` while it is rendering. */
  failure: string | null;
}

/**
 * A boundary around one view of the studio.
 *
 * The studio had none. React unmounts the whole root when any component throws,
 * so one row the datasource returned without the field it declared took the
 * ontology map, every other person and the navigation down with it — selecting
 * one person blanked the application. A boundary per view makes the blast radius
 * the view: the failed region says so in place, and its siblings keep rendering
 * and stay interactive.
 *
 * It does NOT swallow. The fallback states what failed and why, and
 * `componentDidCatch` re-reports the original error object to the console, so a
 * developer still gets the value and the stack they would have had.
 *
 * A class because React offers no hook for this: `getDerivedStateFromError` and
 * `componentDidCatch` exist only on a class, and both are called positionally by
 * React rather than with the destructured object argument used everywhere else.
 */
export class ViewBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  override state: ViewBoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): ViewBoundaryState {
    return { failure: thrownText({ error }) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`orangerail studio: ${this.props.view} failed to render.`, error, info);
  }

  override render(): ReactNode {
    const { failure } = this.state;

    if (failure === null) {
      return this.props.children;
    }

    return (
      <div className={styles.boundary} data-testid="view-error" data-view={this.props.view}>
        <p className={styles.headline}>{this.props.view} could not be rendered.</p>
        <p className={styles.reason}>{failure}</p>
        <p className={styles.note}>
          The rest of the studio is unaffected. The full error is in the browser console.
        </p>
      </div>
    );
  }
}
