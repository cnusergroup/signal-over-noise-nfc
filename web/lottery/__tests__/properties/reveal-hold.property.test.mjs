// Feature: after-party-lottery, Property 17: Reveal hold gating
//
// Validates: Requirements 8.6, 9.2
//
// Property 17 (design §"Property 17: Reveal hold gating"): for any sequence of
// winner detections at times t1 < t2 < ..., the reveal for the (i+1)-th winner
// SHALL NOT begin earlier than tᵢ + 8000 ms (8 s after the PREVIOUS reveal
// began), and detections that arrive within a hold window SHALL be queued and
// processed in ascending `drawSeq` order once the hold elapses.
//
// The reveal queue + hold gate live in main.mjs (task 10.3):
//   - `enqueueWinner(winner)` (reached via `scene.queueReveal`) inserts into a
//     FIFO kept sorted ascending by `drawSeq` and then runs the gate.
//   - A reveal records `revealStartedAt = now()`; the next queued winner only
//     starts once `now() - revealStartedAt >= revealHoldMs` (default 8000 ms,
//     DEFAULT_REVEAL_HOLD_MS). The gate is driven by the injected
//     setTimeout/clearTimeout + now, so `vi.useFakeTimers()` controls it.
//
// To exercise the gate in isolation (no DOM, no WebGL, no `three`), this test
// drives the REAL success path of `createLotteryApp` with fully stubbed
// injectables so the machine reaches SphereIdle quickly:
//   - `fetch` returns >= 10 participants for /lottery/participants and an empty
//     winners list for /lottery/winners (so the background poll never injects
//     reveals — every detection in this test is enqueued explicitly).
//   - `loadFont` / `createNicknameMesh` / `createLetterFormation` /
//     `createSphereFormation` are trivial stubs; the sphere reports
//     `complete: true` so the convergence wait resolves immediately, and the
//     per-letter hold is set to 0 ms so `run()` settles into SphereIdle within a
//     few microtasks.
//   - `createWinnerReveal` returns a mock reveal driver that records, per reveal,
//     the revealed nickname and the (faked) `Date.now()` at which the reveal
//     started — exactly the moment main.mjs sets `revealStartedAt`.
//
// With that wiring we enqueue winner 1 at t1 (its reveal starts immediately),
// enqueue the remaining winners — in arbitrary `drawSeq` order — at instants
// strictly inside (t1, t1 + 8000), then advance the fake clock and assert:
//   (a) the second reveal's start time is >= t1 + 8000 (and every consecutive
//       reveal is gated by >= 8000 ms), and
//   (b) the order in which winners enter the reveal is ascending by `drawSeq`.

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

import { createLotteryApp, State, DEFAULT_REVEAL_HOLD_MS } from '../../main.mjs';

/** Minimum hold (ms) between consecutive reveals (Requirement 8.6 default). */
const HOLD = DEFAULT_REVEAL_HOLD_MS; // 8000

/** Minimum participants required for the success path (Requirement 6.2). */
const MIN_PARTICIPANTS = 10;

/**
 * Build a fetch stub: >= 10 participants for the participants endpoint, an empty
 * winners list for the winners poll (so only explicit enqueues drive reveals).
 * @param {string[]} participantNicks
 * @returns {(url: string) => Promise<object>}
 */
function makeFetch(participantNicks) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/lottery/participants')) {
      return jsonResponse({
        count: participantNicks.length,
        participants: participantNicks.map((nickname) => ({ nickname })),
      });
    }
    // /lottery/winners — empty, so the background poll never queues a reveal.
    return jsonResponse({ count: 0, winners: [] });
  };
}

/** Minimal fetch Response stand-in exposing the surface LotteryClient touches. */
function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

// A scenario: K distinct winners (so there is a meaningful "second reveal"),
// each with a unique drawSeq; the K-1 non-first winners arrive at offsets that
// are strictly inside the first hold window (0, HOLD). `t1` is the first
// detection time (>= 0). The generated `drawSeqs` order is deliberately arbitrary
// so the queue's ascending-by-drawSeq sort is actually exercised.
const scenarioArb = fc.integer({ min: 2, max: 6 }).chain((k) =>
  fc.record({
    k: fc.constant(k),
    drawSeqs: fc.uniqueArray(fc.integer({ min: 1, max: 100000 }), {
      minLength: k,
      maxLength: k,
    }),
    arrivalOffsets: fc.array(fc.integer({ min: 1, max: HOLD - 1 }), {
      minLength: k - 1,
      maxLength: k - 1,
    }),
    t1: fc.integer({ min: 0, max: 5000 }),
  }),
);

describe('Property 17: Reveal hold gating', () => {
  it('gates the next reveal by >= 8000 ms and processes within-window detections in ascending drawSeq order', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ k, drawSeqs, arrivalOffsets, t1 }) => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        /** @type {Array<{ nickname: string, t: number }>} */
        const revealLog = [];
        let app;
        try {
          // Winners: nickname encodes the drawSeq so the reveal driver can record
          // which winner was revealed and we can map back to its drawSeq.
          const nick = (seq) => `W${seq}`;
          const winners = drawSeqs.map((seq) => ({
            drawSeq: seq,
            nickname: nick(seq),
            tagId: `tag-${seq}`,
            drawnAt: new Date(seq).toISOString(),
          }));
          const seqByNick = new Map(winners.map((w) => [w.nickname, w.drawSeq]));

          // Participants include every winner nickname (so each reveal matches a
          // mesh, not the unknown-winner path) plus fillers to reach the minimum.
          const participantNicks = winners.map((w) => w.nickname);
          for (let i = participantNicks.length; i < MIN_PARTICIPANTS; i++) {
            participantNicks.push(`F${i}`);
          }

          const scene = {
            onReveal: null,
            camera: null,
            add() {},
            remove() {},
            queueReveal(winner) {
              if (typeof this.onReveal === 'function') this.onReveal(winner);
            },
          };

          // Mock reveal driver: record the nickname + the faked clock at the exact
          // moment the reveal begins (main.mjs calls revealWinner right after
          // setting revealStartedAt = now()).
          const revealDriver = {
            revealWinner(mesh) {
              revealLog.push({ nickname: mesh.nickname, t: Date.now() });
            },
            revealUnknownWinner(nickname) {
              revealLog.push({ nickname, t: Date.now() });
            },
            clear() {},
            update() {},
            isHoldComplete() {
              return true;
            },
          };

          app = createLotteryApp({
            scene,
            document: null,
            fetch: makeFetch(participantNicks),
            now: () => Date.now(),
            setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
            clearTimeout: (id) => globalThis.clearTimeout(id),
            loadFont: async () => ({}),
            createNicknameMesh: (nickname) => ({ nickname }),
            createLetterFormation: () => ({
              formLetter: async () => {},
              dispersToOpacityZero: async () => {},
              update() {},
            }),
            createSphereFormation: () => ({ object3d: {}, complete: true, update() {} }),
            createWinnerReveal: () => revealDriver,
            registerTickable: () => () => {},
            // Collapse the per-letter holds so run() reaches SphereIdle promptly;
            // leave revealHoldMs at its 8000 ms default (the value under test).
            letterHoldMs: 0,
          });

          await app.run();
          // Guard: the success path must have settled into the steady state from
          // which reveals are triggered.
          expect(app.state).toBe(State.SphereIdle);

          // The chronologically-first draw is the smallest drawSeq (drawSeq is
          // monotonic with detection order). It is detected at t1 and revealed
          // immediately; the rest arrive — out of drawSeq order — within the hold.
          const ascending = [...drawSeqs].sort((a, b) => a - b);
          const minSeq = ascending[0];
          const firstWinner = winners.find((w) => w.drawSeq === minSeq);
          const queued = winners.filter((w) => w.drawSeq !== minSeq); // generator order

          // Detect winner 1 at t1 → its reveal starts synchronously.
          if (t1 > 0) await vi.advanceTimersByTimeAsync(t1);
          scene.queueReveal(firstWinner);
          expect(revealLog.length).toBe(1);
          expect(revealLog[0].t).toBe(t1);

          // Detect the remaining winners at strictly increasing instants, all
          // inside (t1, t1 + HOLD). Each must be queued (no new reveal yet).
          const offsets = [...arrivalOffsets].sort((a, b) => a - b);
          let clock = t1;
          for (let i = 0; i < queued.length; i++) {
            const target = t1 + offsets[i];
            const step = target - clock;
            if (step > 0) {
              await vi.advanceTimersByTimeAsync(step);
              clock = target;
            }
            scene.queueReveal(queued[i]);
            // Still gated behind winner 1's 8 s hold.
            expect(revealLog.length).toBe(1);
          }

          // Elapse enough holds for every queued winner to be revealed in turn.
          await vi.advanceTimersByTimeAsync((k + 2) * HOLD);

          // Every winner revealed exactly once.
          expect(revealLog.length).toBe(k);

          // (a) Hold gating (Requirement 8.6): the second reveal starts no earlier
          // than t1 + HOLD, and every consecutive reveal is gated by >= HOLD ms
          // measured from the previous reveal's start.
          expect(revealLog[1].t).toBeGreaterThanOrEqual(t1 + HOLD);
          for (let i = 1; i < revealLog.length; i++) {
            expect(revealLog[i].t).toBeGreaterThanOrEqual(revealLog[i - 1].t + HOLD);
          }

          // (b) Ordering (Requirement 9.2): winners detected within the hold window
          // are processed in ascending drawSeq order, regardless of arrival order.
          const revealedSeqs = revealLog.map((r) => seqByNick.get(r.nickname));
          expect(revealedSeqs).toEqual(ascending);
        } finally {
          if (app) app.stop();
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      }),
      { numRuns: 100 },
    );
  });
});
