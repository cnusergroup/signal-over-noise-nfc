// Feature: after-party-lottery, Property 19: Connection-status indicator timing
//
// Validates: Requirements 9.5
//
// Property 19 asserts that `StatusIndicator.update(now, lastSuccessAt)` from
// `web/lottery/status-indicator.mjs` resolves the connection state purely from
// the elapsed time since the last successful poll:
//
//   connected  iff  now - lastSuccessAt <= 6000   (boundary inclusive)
//   disconnected otherwise
//
// When connected, the bound element carries the `connected` class (and not
// `disconnected`), shows the Simplified Chinese label "已连接", and `update`
// returns `true`. When disconnected, the element carries `disconnected` (and not
// `connected`), shows "未连接", and `update` returns `false`.
//
// `StatusIndicator` only touches `element.classList.add/remove` and
// `element.textContent`, so this test injects a minimal stub element rather than
// standing up jsdom — keeping the suite in the default Node environment.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { StatusIndicator } from '../../status-indicator.mjs';

/** The inclusive window, in milliseconds, within which the connection is alive. */
const CONNECTED_WINDOW_MS = 6000;

/**
 * Build a minimal stub DOM element exposing only the surface StatusIndicator
 * uses: a `classList` with `add`/`remove`/`contains` (backed by a Set) and a
 * mutable `textContent` string. This lets the test run without jsdom.
 *
 * @returns {{ classList: { add: Function, remove: Function, contains: Function }, textContent: string }}
 */
function makeStubElement() {
  const classes = new Set();
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    textContent: '',
  };
}

/**
 * Assert the full connected/disconnected invariant for one (now, lastSuccessAt)
 * pair: class membership, label text, and the boolean return value all agree
 * with the `now - lastSuccessAt <= 6000` predicate.
 *
 * @param {number} now
 * @param {number} lastSuccessAt
 */
function checkPair(now, lastSuccessAt) {
  const element = makeStubElement();
  const indicator = new StatusIndicator({ element });

  const expectedConnected = (now - lastSuccessAt) <= CONNECTED_WINDOW_MS;
  const result = indicator.update(now, lastSuccessAt);

  expect(result).toBe(expectedConnected);

  if (expectedConnected) {
    expect(element.classList.contains('connected')).toBe(true);
    expect(element.classList.contains('disconnected')).toBe(false);
    expect(element.textContent).toBe('已连接');
  } else {
    expect(element.classList.contains('disconnected')).toBe(true);
    expect(element.classList.contains('connected')).toBe(false);
    expect(element.textContent).toBe('未连接');
  }
}

describe('Property 19: Connection-status indicator timing', () => {
  it('sets `connected` iff now - lastSuccessAt <= 6000 across arbitrary integer pairs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        (now, lastSuccessAt) => {
          checkPair(now, lastSuccessAt);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('generates timestamps via a diff so the 6000 ms boundary is well covered', () => {
    // Anchor `lastSuccessAt` anywhere and choose `now` as `lastSuccessAt + diff`,
    // where `diff` is biased around the 6000 ms boundary (including negative diffs
    // for now < lastSuccessAt). This guarantees the generator spends runs exactly
    // on, just below, and just above the boundary rather than relying on chance.
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -10_000, max: 20_000 }),
        (lastSuccessAt, diff) => {
          checkPair(lastSuccessAt + diff, lastSuccessAt);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('treats the boundary cases explicitly: 5999/6000 connected, 6001 disconnected, negative diff connected', () => {
    const base = 1_700_000_000_000; // arbitrary fixed anchor

    // diff === 5999 → connected
    checkPair(base + 5999, base);
    // diff === 6000 (exact inclusive boundary) → connected
    checkPair(base + 6000, base);
    // diff === 6001 → disconnected
    checkPair(base + 6001, base);
    // now < lastSuccessAt (negative diff) → connected
    checkPair(base - 1, base);
    checkPair(base - 100_000, base);
    // diff === 0 → connected
    checkPair(base, base);
  });
});
