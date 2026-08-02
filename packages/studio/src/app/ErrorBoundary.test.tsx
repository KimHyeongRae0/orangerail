// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewBoundary } from './ErrorBoundary';

/** A child that throws on render, standing in for any component that fails. */
const Exploding = ({ message }: { message: string }) => {
  throw new Error(message);
};

afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ViewBoundary (ONT-072 AC-3)', () => {
  it('names the view that failed and leaves its siblings rendering', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = render(
      <div>
        <ViewBoundary view="The person scorecard">
          <Exploding message="complexityMix is undefined" />
        </ViewBoundary>
        <p data-testid="sibling">the ontology map</p>
      </div>,
    );

    const fallback = container.querySelector('[data-testid="view-error"]');

    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute('data-view')).toBe('The person scorecard');
    expect(fallback?.textContent).toContain('The person scorecard could not be rendered.');
    expect(fallback?.textContent).toContain('complexityMix is undefined');

    // The root survived: the sibling view is still in the document, which is the
    // whole difference from an unmounted React root.
    expect(container.querySelector('[data-testid="sibling"]')?.textContent).toBe(
      'the ontology map',
    );
  });

  it('does not swallow: the original error object still reaches the console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ViewBoundary view="The toolbar">
        <Exploding message="boom" />
      </ViewBoundary>,
    );

    const reported = spy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('The toolbar failed to render.'),
    );

    expect(reported).toBeDefined();
    expect(reported?.[1]).toBeInstanceOf(Error);
    expect((reported?.[1] as Error).message).toBe('boom');
  });

  it('survives a thrown value that cannot describe itself', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const hostile = {
      toString: () => {
        throw new Error('not even a string');
      },
    };
    const Throwing = () => {
      throw hostile;
    };

    const { container } = render(
      <ViewBoundary view="The detail panel">
        <Throwing />
      </ViewBoundary>,
    );

    expect(container.querySelector('[data-testid="view-error"]')?.textContent).toContain(
      'an error that cannot describe itself',
    );
  });

  it('a boundary that fails while rendering its own message is caught by the outer one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // An object where a view name belongs: React refuses to render it as a
    // child, so the INNER boundary throws from inside its own fallback — the
    // one failure a per-view boundary cannot handle for itself.
    const brokenView = {} as unknown as string;

    const { container } = render(
      <ViewBoundary view="The studio">
        <ViewBoundary view={brokenView}>
          <Exploding message="the first failure" />
        </ViewBoundary>
      </ViewBoundary>,
    );

    const fallbacks = container.querySelectorAll('[data-testid="view-error"]');

    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0]?.getAttribute('data-view')).toBe('The studio');
    expect(container.textContent).toContain('The studio could not be rendered.');
  });

  it('a new selection gets a fresh boundary, so a second failure needs no reload', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container, rerender } = render(
      <ViewBoundary key="acc_a" view="The person scorecard">
        <Exploding message="row A" />
      </ViewBoundary>,
    );

    expect(container.querySelector('[data-testid="view-error"]')).not.toBeNull();

    rerender(
      <ViewBoundary key="acc_b" view="The person scorecard">
        <p data-testid="row-b">row B renders</p>
      </ViewBoundary>,
    );

    expect(container.querySelector('[data-testid="view-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="row-b"]')?.textContent).toBe('row B renders');
  });
});
