// Feature: after-party-lottery, Property 18: Polling connection state machine
//
// Validates: Requirements 9.3, 9.4
//
// Property 18 — for any sequence of poll outcomes (each 'success' or 'failure'),
// driving the LotteryClient one poll at a time yields a connection state machine
// that satisfies, after every poll i:
//
//   1. connected === false (disconnected)  IFF  there exists a window of 3
//      consecutive failures with no later success — i.e. the number of failures
//      since the last success (the trailing failure run) is >= the failure
//      threshold of 3 (Requirement 9.3).
//   2. nextInterval() === 5000 ms while disconnected and 3000 ms while connected
//      (Requirements 9.3, 9.4): polling slows to 5 s on disconnect and resumes
//      the 3 s cadence on reconnect.
//   3. failureStreak resets to 0 on every successful poll, and otherwise counts
//      consecutive failures (Requirement 9.4).
//
// The "windowed" reference (trailing failure run length) and the "streak-based"
// reference (a direct simulation of the documented state machine) are computed
// independently and asserted to agree with each other and with the live client,
// closing the loop between the spec wording and the implementation.
//
// Each poll is driven through the instance method `client._pollOnce()` so we
// consume exactly one mocked fetch per outcome without engaging the self-
// scheduling timer loop (no fake timers required, no runaway scheduling).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { LotteryClient } from '../../lottery-client.mjs';

const POLL_INTERVAL_MS = 3000;
const DISCONNECTED_INTERVAL_MS = 5000;
const FAILURE_THRESHOLD = 3;

/**
 * Build a deterministic mock fetch that consumes one outcome from `outcomes`
 * per call (one call == one `_pollOnce`). A 'success' resolves an ok/200 winners
 * response; a 'failure' cycles through the three distinguishable failure kinds
 * the client treats identically — a thrown network error, an `ok:false` HTTP 500,
 * and an `ok:false` HTTP 503 — so all failure branches of `_fetchJson` are exercised.
 *
 * @param {Array<'success'|'failure'>} outcomes - Ordered poll outcomes.
 * @returns {(url: string, opts?: object) => Promise<object>} A fetch stand-in.
 */
function makeMockFetch(outcomes) {
  let callIndex = 0;
  let failureVariant = 0;
  return async () => {
    const outcome = outcomes[callIndex++];
    if (outcome === 'success') {
      return { ok: true, status: 200, json: async () => ({ winners: [] }) };
    }
    // failure: rotate through the three failure kinds
    const variant = failureVariant++ % 3;
    if (variant === 0) {
      throw new Error('network error');
    }
    if (variant === 1) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
}

/**
 * Reference simulation of the documented connection state machine.
 * @param {Array<'success'|'failure'>} prefix - Outcomes applied so far (inclusive).
 * @returns {{ connected: boolean, failureStreak: number }}
 */
function simulate(prefix) {
  let connected = true;
  let failureStreak = 0;
  for (const outcome of prefix) {
    if (outcome === 'success') {
      failureStreak = 0;
      connected = true;
    } else {
      failureStreak += 1;
      if (failureStreak >= FAILURE_THRESHOLD) connected = false;
    }
  }
  return { connected, failureStreak };
}

/**
 * Windowed reference: the length of the trailing run of consecutive failures
 * (failures since the last success). A window of >= 3 trailing failures with no
 * later success is exactly the disconnect condition of Requirement 9.3.
 * @param {Array<'success'|'failure'>} prefix - Outcomes applied so far (inclusive).
 * @returns {number} Count of trailing failures.
 */
function trailingFailures(prefix) {
  let count = 0;
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (prefix[i] === 'failure') count += 1;
    else break;
  }
  return count;
}

describe('Property 18: Polling connection state machine', () => {
  it('tracks connected/interval/failureStreak across arbitrary poll sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('success', 'failure'), { minLength: 1, maxLength: 60 }),
        async (outcomes) => {
          const scene = { queueReveal() {} };
          const client = new LotteryClient('http://lottery.test', scene, {
            fetch: makeMockFetch(outcomes),
            now: () => 1000,
            pollInterval: POLL_INTERVAL_MS,
            disconnectedInterval: DISCONNECTED_INTERVAL_MS,
            failureThreshold: FAILURE_THRESHOLD,
          });

          // Initial state, before any poll: connected, 3 s cadence, no failures.
          expect(client.connected).toBe(true);
          expect(client.nextInterval()).toBe(POLL_INTERVAL_MS);
          expect(client.failureStreak).toBe(0);

          for (let i = 0; i < outcomes.length; i++) {
            await client._pollOnce();

            const prefix = outcomes.slice(0, i + 1);
            const { connected: expectedConnected, failureStreak: expectedStreak } =
              simulate(prefix);
            const windowedFailures = trailingFailures(prefix);
            const expectedDisconnectedWindowed = windowedFailures >= FAILURE_THRESHOLD;

            // The windowed reference and the streak-based reference must agree.
            expect(expectedDisconnectedWindowed).toBe(!expectedConnected);
            expect(windowedFailures).toBe(expectedStreak);

            // Live client matches the references.
            expect(client.connected).toBe(expectedConnected);
            expect(client.failureStreak).toBe(expectedStreak);

            // Polling interval: 5000 ms while disconnected, 3000 ms while connected.
            expect(client.nextInterval()).toBe(
              expectedConnected ? POLL_INTERVAL_MS : DISCONNECTED_INTERVAL_MS,
            );

            // failureStreak resets to 0 on every successful poll.
            if (outcomes[i] === 'success') {
              expect(client.failureStreak).toBe(0);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
