// Feature: after-party-lottery — lottery page entry point + animation state machine.
//
// This module wires the Three.js scene, the LotteryClient, the formation/reveal
// animations, and the connection-status indicator into the single state machine
// that drives the big-screen lottery display (design §2.2 state diagram, §2.3
// modules table). The state progression is:
//
//   Loading → LetterA → LetterW → LetterS → SphereForming → SphereIdle
//           → Revealing → RevealHold        (+ a terminal Error state)
//
// Requirement 6.2 is the load-time gate: if `GET /lottery/participants` fails OR
// returns fewer than 10 participants, the machine enters Error and NEVER forms a
// letter or a sphere. To make that gate testable under jsdom with a mocked fetch
// (property test 10.5) — and to keep this module importable without a WebGL stack
// — the design splits into two layers:
//
//   1. `createLotteryApp(deps)` — the pure-ish state machine. All of its
//      environment (fetch, timers, the scene, the document) and every Three.js
//      dependent construction (font loading, NicknameMesh, SphereFormation) is
//      INJECTED. The participant fetch + state-transition logic uses only the
//      injected fetch/timers, so a test can drive the whole Loading → Error path
//      with a mocked fetch and a stub scene, never touching `three`/WebGL.
//
//   2. `bootstrap()` — the real browser entry. It dynamically imports the
//      `three`-dependent modules (scene.mjs, nickname-mesh.mjs, sphere-formation.mjs)
//      and supplies the real factories to `createLotteryApp`, then runs it.
//
// Only `three`-free modules are imported statically below, so importing this file
// in node/jsdom (as the property tests do) does not attempt to resolve `three` or
// the pinned example/jsm addon URLs.

import { LotteryClient } from './lottery-client.mjs';
import { LetterFormation } from './letter-formation.mjs';
import { WinnerReveal } from './winner-reveal.mjs';
import { StatusIndicator } from './status-indicator.mjs';

/**
 * The lottery animation state machine states (design §2.2). Frozen so callers can
 * compare against stable string values without risk of mutation.
 *
 * @readonly
 * @enum {string}
 */
export const State = Object.freeze({
  /** Fetching the participant list; no meshes built yet. */
  Loading: 'Loading',
  /** Nicknames arranged into the letter "A". */
  LetterA: 'LetterA',
  /** Nicknames arranged into the letter "W". */
  LetterW: 'LetterW',
  /** Nicknames arranged into the letter "S". */
  LetterS: 'LetterS',
  /** Nicknames converging from the last letter into the sphere. */
  SphereForming: 'SphereForming',
  /** Steady state: the noise-wrapped sphere rotates, awaiting a draw. */
  SphereIdle: 'SphereIdle',
  /** A drawn winner's noise is dissolving into a clear signal. */
  Revealing: 'Revealing',
  /** The revealed winner is held on screen before the next draw is processed. */
  RevealHold: 'RevealHold',
  /** Terminal failure: fetch failed or fewer than 10 participants (Requirement 6.2). */
  Error: 'Error',
});

/** Default minimum participant count to start the animation (Requirement 6.2). */
export const MIN_PARTICIPANTS = 10;

/** Default hold duration for each formed letter, in ms (Requirements 6.4, 6.5). */
export const DEFAULT_LETTER_HOLD_MS = 4000;

/**
 * Default minimum hold of a revealed winner before the next queued winner is
 * processed, in ms (Requirement 8.6 / 9.2). Measured from the moment the previous
 * reveal began. Kept in sync with WinnerReveal's own `holdMs` default.
 */
export const DEFAULT_REVEAL_HOLD_MS = 8000;

/**
 * Pinned Three.js typeface JSON consumed by `FontLoader`/`TextGeometry` to build
 * the nickname meshes. Pinned to the same Three.js version as lottery.html's
 * importmap so a single library version is used throughout.
 * @type {string}
 */
export const DEFAULT_FONT_URL =
  'https://unpkg.com/three@0.160.0/examples/fonts/helvetiker_regular.typeface.json';

/**
 * API base URL of the deployed HTTP API (matches the value used by the other
 * frontend pages, e.g. signal_hunt.html). The lottery display PC holds no
 * credentials and only calls the public `/lottery/participants` + `/lottery/winners`
 * routes.
 * @type {string}
 */
export const DEFAULT_API_BASE = 'https://7orrwwprye.execute-api.ap-northeast-1.amazonaws.com';

/**
 * Create the lottery animation state machine.
 *
 * Every environment and Three.js dependency is injected so the machine can run
 * both in the real browser (via {@link bootstrap}) and in a headless jsdom test
 * with a mocked fetch and a stub scene. The Loading → Error path (Requirement
 * 6.2) exercises only the injected fetch/timers and never invokes any of the
 * Three.js-dependent factories.
 *
 * @param {object} [deps]
 * @param {object} [deps.scene] - The Three.js scene wrapper. Must expose
 *   `queueReveal(winner)` and (for the success path) `add(mesh)`, `remove(mesh)`,
 *   an assignable `onReveal` hook, and a `camera`. Defaults to an inert no-op
 *   scene so the failure path is safe without a real renderer.
 * @param {Document} [deps.document] - Document used to toggle the error overlay.
 *   Defaults to the global `document` when present.
 * @param {typeof fetch} [deps.fetch] - Fetch implementation passed to the
 *   LotteryClient. Defaults to the global `fetch`.
 * @param {() => number} [deps.now] - Clock used by the LotteryClient. Defaults to `Date.now`.
 * @param {(cb: () => void, ms: number) => any} [deps.setTimeout] - Timer used for
 *   letter holds and the sphere-convergence poll. Defaults to the global `setTimeout`.
 * @param {(id: any) => void} [deps.clearTimeout] - Paired clear. Defaults to the global.
 * @param {LotteryClient} [deps.client] - Pre-built client. When omitted one is
 *   constructed from `apiBase`, `scene`, `fetch`, and `now`.
 * @param {string} [deps.apiBase=DEFAULT_API_BASE] - API base for the constructed client.
 * @param {(url: string) => Promise<object>} [deps.loadFont] - Loads the typeface
 *   font (Three.js `FontLoader`). Required for the success path; never called on
 *   the failure path.
 * @param {string} [deps.fontUrl=DEFAULT_FONT_URL] - URL passed to `loadFont`.
 * @param {(nickname: string, font: object) => object} [deps.createNicknameMesh] -
 *   Builds one NicknameMesh per participant. Required for the success path.
 * @param {(meshes: Array<object>) => object} [deps.createLetterFormation] - Builds
 *   the LetterFormation. Defaults to `new LetterFormation(meshes, { documentRef })`.
 * @param {(meshes: Array<object>, camera: object) => object} [deps.createSphereFormation] -
 *   Builds the SphereFormation (Three.js-dependent). Required for the success path.
 * @param {(options: object) => object} [deps.createWinnerReveal] - Builds the
 *   WinnerReveal. Defaults to `new WinnerReveal(options)`.
 * @param {(driver: { update: (dt: number) => void }) => (() => void)} [deps.registerTickable] -
 *   Registers a per-frame driver (one with an `update(dt)` method) with the render
 *   loop and returns an unregister function. Defaults to a no-op (the real
 *   bootstrap wraps the driver in an empty group and adds it to the scene).
 * @param {number} [deps.minParticipants=MIN_PARTICIPANTS] - Minimum to proceed.
 * @param {number} [deps.letterHoldMs=DEFAULT_LETTER_HOLD_MS] - Per-letter hold (ms).
 * @param {number} [deps.revealHoldMs=DEFAULT_REVEAL_HOLD_MS] - Minimum hold (ms) that
 *   must elapse from the start of one reveal before the next queued winner is
 *   processed (Requirement 8.6 / 9.2).
 * @param {string} [deps.errorOverlayId='error-overlay'] - Id of the error overlay element.
 * @returns {object} The app handle: `{ state, subscribe, run, start, stop, ... }`.
 */
export function createLotteryApp(deps = {}) {
  const {
    scene = createNoopScene(),
    document: documentRef = (typeof document !== 'undefined' ? document : null),
    fetch: fetchImpl = (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined),
    now = (() => Date.now()),
    setTimeout: setTimeoutImpl = (typeof setTimeout !== 'undefined' ? setTimeout : null),
    clearTimeout: clearTimeoutImpl = (typeof clearTimeout !== 'undefined' ? clearTimeout : null),
    client,
    apiBase = DEFAULT_API_BASE,
    loadFont,
    fontUrl = DEFAULT_FONT_URL,
    createNicknameMesh,
    createLetterFormation = (meshes) => new LetterFormation(meshes, { documentRef }),
    createSphereFormation,
    createWinnerReveal = (options) => new WinnerReveal(options),
    registerTickable = () => () => {},
    minParticipants = MIN_PARTICIPANTS,
    letterHoldMs = DEFAULT_LETTER_HOLD_MS,
    revealHoldMs = DEFAULT_REVEAL_HOLD_MS,
    errorOverlayId = 'error-overlay',
  } = deps;

  const app = {
    // --- Public, observable state -------------------------------------------
    /** @type {string} */
    _state: State.Loading,
    /** @type {Set<(state: string, app: object) => void>} */
    _subscribers: new Set(),
    /** @type {boolean} */
    _started: false,

    // --- Wiring (populated on the success path) -----------------------------
    /** @type {?Error} The error that drove the machine into the Error state. */
    error: null,
    /** @type {Array<object>} The constructed nickname meshes (one per participant). */
    meshes: [],
    /** @type {?object} The active LetterFormation. */
    letterFormation: null,
    /** @type {?object} The active SphereFormation. */
    sphereFormation: null,
    /** @type {?object} The WinnerReveal driver. */
    winnerReveal: null,
    /**
     * FIFO of winners awaiting reveal, kept sorted ascending by `drawSeq` so that
     * winners detected within a hold window are processed in chronological order
     * (Requirement 9.2). Populated via {@link enqueueWinner} from `scene.queueReveal`.
     * @type {Array<object>}
     */
    pendingWinners: [],
    /**
     * Timestamp (from the injected `now`) at which the in-progress reveal began, or
     * null when no reveal is active. The next queued winner may only start once
     * `now() - revealStartedAt >= revealHoldMs` (Requirement 8.6).
     * @type {?number}
     */
    revealStartedAt: null,
    /** Pending hold timer id (from the injected setTimeout), or null. @type {?any} */
    _holdTimerId: null,
    /** @type {?object} The LotteryClient (built lazily / injected). */
    client: client || null,

    /** Current state name. @returns {string} */
    get state() {
      return this._state;
    },

    /**
     * Subscribe to state transitions. The listener is invoked with the new state
     * after every change. Returns an unsubscribe function.
     * @param {(state: string, app: object) => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      if (typeof listener === 'function') this._subscribers.add(listener);
      return () => this._subscribers.delete(listener);
    },

    /**
     * Run the state machine to its first steady/terminal state. Resolves once the
     * machine reaches SphereIdle (success) or Error (failure). Idempotent: a
     * second call is a no-op that resolves immediately.
     * @returns {Promise<void>}
     */
    async run() {
      if (this._started) return;
      this._started = true;

      this._ensureClient();
      this._setState(State.Loading);

      let result;
      try {
        result = await this.client.loadParticipants();
      } catch (err) {
        // Requirement 6.2: any fetch failure or count < 10 ends in Error and the
        // letter-formation sequence is never started.
        this._enterError(err);
        return;
      }

      try {
        await this._runFormationSequence(result.participants || []);
      } catch (err) {
        // A failure while building/animating the scene (e.g. font load, WebGL)
        // also surfaces the error overlay rather than leaving a half-built scene.
        this._enterError(err);
      }
    },

    /**
     * Alias for {@link run} (the task interface allows either `start()` or `run()`).
     * @returns {Promise<void>}
     */
    start() {
      return this.run();
    },

    /** Stop the underlying poll loop, if any, and cancel a pending hold timer. */
    stop() {
      if (this.client && typeof this.client.stop === 'function') this.client.stop();
      this._clearHoldTimer();
    },

    // --- Internal: state plumbing -------------------------------------------

    /**
     * Transition to `next`, notifying subscribers. No-op if already in `next`.
     * @param {string} next
     * @private
     */
    _setState(next) {
      if (this._state === next) return;
      this._state = next;
      for (const listener of this._subscribers) {
        try {
          listener(next, this);
        } catch (err) {
          // A misbehaving subscriber must not break the state machine.
          // eslint-disable-next-line no-console
          if (typeof console !== 'undefined') console.error('[lottery] state subscriber threw:', err);
        }
      }
    },

    /**
     * Enter the terminal Error state: record the error, reveal the error overlay
     * (Requirement 6.2), and never form letters or a sphere.
     * @param {Error} err
     * @private
     */
    _enterError(err) {
      this.error = err || new Error('Unknown lottery error');
      if (typeof console !== 'undefined') {
        // eslint-disable-next-line no-console
        console.error('[lottery] entering Error state:', this.error);
      }
      if (documentRef && typeof documentRef.getElementById === 'function') {
        const overlay = documentRef.getElementById(errorOverlayId);
        if (overlay) overlay.hidden = false;
      }
      this._setState(State.Error);
    },

    /** Lazily construct the LotteryClient from the injected fetch/clock. @private */
    _ensureClient() {
      if (this.client) return;
      this.client = new LotteryClient(apiBase, scene, {
        fetch: fetchImpl,
        now,
        minParticipants,
      });
    },

    /**
     * Promise that resolves after `ms` using the injected timer.
     * @param {number} ms
     * @returns {Promise<void>}
     * @private
     */
    _hold(ms) {
      if (!setTimeoutImpl || ms <= 0) return Promise.resolve();
      return new Promise((resolve) => setTimeoutImpl(resolve, ms));
    },

    // --- Internal: success-path formation sequence --------------------------

    /**
     * Build the nickname meshes and run the full A → W → S → sphere sequence,
     * then settle into SphereIdle and begin polling for winners. Only reached
     * once at least `minParticipants` participants were loaded.
     * @param {Array<{ nickname: string }>} participants
     * @returns {Promise<void>}
     * @private
     */
    async _runFormationSequence(participants) {
      if (typeof loadFont !== 'function') {
        throw new Error('createLotteryApp requires a `loadFont` dependency for the formation sequence.');
      }
      if (typeof createNicknameMesh !== 'function') {
        throw new Error('createLotteryApp requires a `createNicknameMesh` dependency for the formation sequence.');
      }

      // Build one NicknameMesh per participant from the loaded font and add each
      // to the scene so its noise clock is ticked by the render loop.
      const font = await loadFont(fontUrl);
      const meshes = participants.map((p) => createNicknameMesh(p.nickname, font));
      this.meshes = meshes;
      for (const mesh of meshes) scene.add(mesh);

      // Letter formations move the (already-added) meshes; register the formation
      // so its tween `update(dt)` is ticked each frame.
      const letter = createLetterFormation(meshes);
      this.letterFormation = letter;
      const unregisterLetter = registerTickable(letter);

      // A (form, hold 4s, disperse) → W (...) → S (...)  — one letter at a time,
      // each dispersing to opacity 0 before the next forms (Requirement 6.6).
      await this._runLetter(letter, 'A', State.LetterA, letterHoldMs);
      await this._runLetter(letter, 'W', State.LetterW, letterHoldMs);
      await this._runLetter(letter, 'S', State.LetterS, letterHoldMs);

      if (typeof unregisterLetter === 'function') unregisterLetter();

      // Converge into the rotating, noise-wrapped sphere (Requirements 7.1, 7.3).
      if (typeof createSphereFormation !== 'function') {
        throw new Error('createLotteryApp requires a `createSphereFormation` dependency for the sphere phase.');
      }
      this._setState(State.SphereForming);
      const camera = scene && scene.camera ? scene.camera : null;
      const sphere = createSphereFormation(meshes, camera);
      this.sphereFormation = sphere;
      // SphereFormation exposes `.object3d` (its rotating group) + `update(dt)`,
      // so scene.add adds the group and registers the per-frame tick.
      scene.add(sphere);
      await this._waitForSphere(sphere);

      // Steady state. Wire the reveal hook and start polling for winners.
      this._setState(State.SphereIdle);
      this._setupReveal(font);
      if (this.client && typeof this.client.start === 'function') this.client.start();
      // Any winners detected before the sphere settled were held in the FIFO;
      // process them now that the steady state and reveal driver exist.
      this._processQueue();
    },

    /**
     * Form one letter, hold it, then disperse it to opacity 0.
     * @param {object} letter - The LetterFormation.
     * @param {'A'|'W'|'S'} glyph
     * @param {string} state - The State value for this letter.
     * @param {number} holdMs
     * @returns {Promise<void>}
     * @private
     */
    async _runLetter(letter, glyph, state, holdMs) {
      this._setState(state);
      await letter.formLetter(glyph);
      await this._hold(holdMs);
      await letter.dispersToOpacityZero();
    },

    /**
     * Resolve once the sphere convergence tween reports complete. Polls the
     * formation's `complete` flag with the injected timer (the render loop drives
     * the convergence; this just waits for it).
     * @param {object} sphere
     * @returns {Promise<void>}
     * @private
     */
    _waitForSphere(sphere) {
      if (!sphere || sphere.complete) return Promise.resolve();
      if (!setTimeoutImpl) return Promise.resolve();
      return new Promise((resolve) => {
        const poll = () => {
          if (sphere.complete) {
            resolve();
          } else {
            setTimeoutImpl(poll, 100);
          }
        };
        poll();
      });
    },

    // --- Internal: reveal queue with hold gating (task 10.3) ----------------
    //
    // The LotteryClient forwards each newly detected winner via `scene.queueReveal`,
    // which we route into a FIFO ordered by `drawSeq`. A reveal may begin only when
    // the machine is idle (SphereIdle) or a previous reveal's >= 8 s hold has fully
    // elapsed (RevealHold). The gate is measured from the moment the PREVIOUS reveal
    // began (`revealStartedAt`): the next winner starts no earlier than
    // `revealStartedAt + revealHoldMs` (Requirement 8.6). When the hold elapses and
    // the queue is empty, the machine returns to SphereIdle (design §2.2).

    /**
     * Build the WinnerReveal driver and route `scene.queueReveal` into the pending
     * winner queue. The driver's `update(dt)` is ticked by the render loop so its
     * dissolve/grow tween (and the WinnerReveal-side hold tracking) advance; the
     * queue's own >= 8 s gate is driven independently by the injected timer so it
     * works under fake timers without a render loop.
     * @param {object} font - The loaded font (used to mint an unknown-winner mesh).
     * @private
     */
    _setupReveal(font) {
      this.winnerReveal = createWinnerReveal({
        scene,
        font,
        count: this.meshes.length,
        holdMs: revealHoldMs,
        createMesh: (nickname) => createNicknameMesh(nickname, font),
      });
      // Register the reveal driver so its `update(dt)` advances the dissolve/grow
      // tween each frame.
      registerTickable(this.winnerReveal);

      // The LotteryClient calls scene.queueReveal(winner) per new draw; route that
      // into our pending queue. The client already forwards in ascending drawSeq
      // order, but enqueueWinner re-sorts defensively in case multiple arrive.
      scene.onReveal = (winner) => this.enqueueWinner(winner);
    },

    /**
     * Enqueue a detected winner and attempt to process the queue. Winners are kept
     * in ascending `drawSeq` order so that several detected within one hold window
     * are revealed chronologically once the hold elapses (Requirement 9.2). Winners
     * lacking a numeric `drawSeq` are appended in arrival order.
     * @param {object} winner - The draw record `{ drawSeq, nickname, ... }`.
     */
    enqueueWinner(winner) {
      if (!winner) return;
      insertByDrawSeq(this.pendingWinners, winner);
      this._processQueue();
    },

    /**
     * Process the reveal queue subject to the hold gate. If a reveal is currently
     * in progress (Revealing) or its hold has not yet elapsed (RevealHold), this
     * schedules a wake-up at the exact moment the hold completes and returns. Once
     * eligible, it starts the next reveal (if any) or — when the queue is empty —
     * returns to SphereIdle.
     * @private
     */
    _processQueue() {
      // Only meaningful once the sphere is the steady state and a reveal driver
      // exists. During Loading/letters/forming we simply hold winners in the FIFO.
      if (!this.winnerReveal) return;
      if (this._state !== State.SphereIdle && this._state !== State.RevealHold) return;

      const remainingMs = this._holdRemainingMs();
      if (remainingMs > 0) {
        // A reveal is still being held; wake up exactly when the hold elapses.
        this._scheduleHoldWake(remainingMs);
        return;
      }

      // The hold (if any) has elapsed. Process the next winner, or settle to idle.
      this._clearHoldTimer();

      if (this.pendingWinners.length === 0) {
        if (this._state === State.RevealHold) {
          // Hold elapsed with nothing queued → back to the rotating sphere.
          if (this.winnerReveal && typeof this.winnerReveal.clear === 'function') {
            this.winnerReveal.clear();
          }
          this.revealStartedAt = null;
          this._setState(State.SphereIdle);
        }
        return;
      }

      this._startReveal(this.pendingWinners.shift());
    },

    /**
     * Begin the reveal for `winner`: record the reveal start time (the anchor for
     * the next winner's >= 8 s gate), run the WinnerReveal sequence on the matching
     * mesh (or mint one for the unknown-winner case, Requirement 8.2), and enter
     * RevealHold. A wake-up is scheduled so the queue is re-evaluated the instant
     * this reveal's hold elapses, even if no further winners arrive.
     * @param {object} winner
     * @private
     */
    _startReveal(winner) {
      this.revealStartedAt = now();
      this._setState(State.Revealing);

      const match = this.meshes.find((m) => m && m.nickname === winner.nickname);
      if (match) {
        this.winnerReveal.revealWinner(match, this.meshes);
      } else if (typeof this.winnerReveal.revealUnknownWinner === 'function') {
        // Unknown-winner case (Requirement 8.2): mint a fresh mesh at the center.
        this.winnerReveal.revealUnknownWinner(winner.nickname, this.meshes);
      }

      this._setState(State.RevealHold);

      // Re-check the queue once this reveal's hold has elapsed, so a lone winner
      // still transitions RevealHold → SphereIdle without a further detection.
      this._scheduleHoldWake(revealHoldMs);
    },

    /**
     * Milliseconds still remaining on the current reveal's hold, or 0 if no reveal
     * is active or the hold has already elapsed. Uses the injected `now` so fake
     * timers control the gate.
     * @returns {number}
     * @private
     */
    _holdRemainingMs() {
      if (this.revealStartedAt == null) return 0;
      const elapsed = now() - this.revealStartedAt;
      const remaining = revealHoldMs - elapsed;
      return remaining > 0 ? remaining : 0;
    },

    /**
     * Schedule a single queue re-evaluation `ms` from now using the injected timer.
     * Any previously scheduled wake-up is cancelled first so only one is pending.
     * @param {number} ms
     * @private
     */
    _scheduleHoldWake(ms) {
      if (!setTimeoutImpl) return;
      this._clearHoldTimer();
      this._holdTimerId = setTimeoutImpl(() => {
        this._holdTimerId = null;
        this._processQueue();
      }, ms > 0 ? ms : 0);
    },

    /** Cancel any pending hold wake-up timer. @private */
    _clearHoldTimer() {
      if (this._holdTimerId != null && clearTimeoutImpl) {
        clearTimeoutImpl(this._holdTimerId);
      }
      this._holdTimerId = null;
    },
  };

  return app;
}

/**
 * Insert `winner` into `queue` keeping it sorted ascending by `drawSeq`, so the
 * reveal queue processes winners in chronological draw order (Requirement 9.2)
 * even when several arrive together or out of order. Winners without a finite
 * numeric `drawSeq` are appended at the end in arrival order. Insertion is stable:
 * a new winner is placed after any existing entry with an equal `drawSeq`.
 *
 * @param {Array<object>} queue - The pending-winners FIFO (mutated in place).
 * @param {object} winner - The draw record to insert.
 */
function insertByDrawSeq(queue, winner) {
  const seq = winner && typeof winner.drawSeq === 'number' && Number.isFinite(winner.drawSeq)
    ? winner.drawSeq
    : null;
  if (seq === null) {
    queue.push(winner);
    return;
  }
  // Find the first element with a strictly greater drawSeq and insert before it.
  let i = 0;
  while (
    i < queue.length &&
    typeof queue[i].drawSeq === 'number' &&
    Number.isFinite(queue[i].drawSeq) &&
    queue[i].drawSeq <= seq
  ) {
    i += 1;
  }
  queue.splice(i, 0, winner);
}

/**
 * An inert scene used when none is injected, so the Loading → Error path never
 * NPEs on a missing renderer. All methods are no-ops; `onReveal` is assignable.
 * @returns {object}
 */
function createNoopScene() {
  return {
    onReveal: null,
    camera: null,
    add() {},
    remove() {},
    queueReveal(winner) {
      if (typeof this.onReveal === 'function') this.onReveal(winner);
    },
  };
}

/**
 * Real browser entry point. Dynamically imports the Three.js-dependent modules
 * (so this file stays importable without `three` in node/jsdom), constructs the
 * real Scene and factories, wires the connection-status indicator, and runs the
 * state machine. Any bootstrap failure reveals the error overlay.
 *
 * @param {object} [overrides] - Optional dependency overrides (mainly for manual
 *   testing in a real page); merged over the real factories.
 * @returns {Promise<object>} The running app handle.
 */
export async function bootstrap(overrides = {}) {
  // Dynamic imports: these modules pull in `three` (and pinned example/jsm addon
  // URLs) which only resolve in the browser via lottery.html's importmap.
  const [sceneMod, nicknameMod, sphereFormationMod, threeMod] = await Promise.all([
    import('./scene.mjs'),
    import('./nickname-mesh.mjs'),
    import('./sphere-formation.mjs'),
    import('three'),
  ]);

  const { Scene } = sceneMod;
  const { NicknameMesh, loadFont } = nicknameMod;
  const { SphereFormation } = sphereFormationMod;
  const THREE = threeMod;

  const scene = new Scene();
  // Pull the camera in so the ~24-name sphere fills more of the frame.
  if (scene.camera) {
    scene.camera.position.set(0, 0, 40);
    scene.camera.lookAt(0, 0, 0);
    scene.camera.updateProjectionMatrix();
  }

  // Wrap a per-frame driver (LetterFormation / WinnerReveal) in an empty group so
  // it can be added to the scene graph (the Scene ticks any added object exposing
  // `update(dt)`). Returns an unregister function.
  const registerTickable = (driver) => {
    const group = new THREE.Group();
    const adapter = { object3d: group, update: (dt) => driver.update(dt) };
    scene.add(adapter);
    return () => scene.remove(adapter);
  };

  // Connection-status indicator (Requirement 9.5): refresh on every connection
  // change and on a steady cadence so the "已连接 / 未连接" label tracks the 6 s window.
  const statusIndicator = new StatusIndicator();
  let appRef = null;
  const refreshStatus = () => {
    if (appRef && appRef.client) {
      statusIndicator.update(Date.now(), appRef.client.lastSuccessAt);
    }
  };

  const client = new LotteryClient(DEFAULT_API_BASE, scene, {
    fetch: window.fetch.bind(window),
    now: () => Date.now(),
    minParticipants: MIN_PARTICIPANTS,
    onConnectionChange: refreshStatus,
  });

  const app = createLotteryApp({
    scene,
    document,
    client,
    fetch: window.fetch.bind(window),
    now: () => Date.now(),
    apiBase: DEFAULT_API_BASE,
    loadFont,
    fontUrl: DEFAULT_FONT_URL,
    createNicknameMesh: (nickname, font) => new NicknameMesh(nickname, font, { size: 1.1, height: 0.15 }),
    createLetterFormation: (meshes) => new LetterFormation(meshes, { documentRef: document }),
    createSphereFormation: (meshes, camera) => new SphereFormation(meshes, camera, { radius: 16 }),
    createWinnerReveal: (options) => new WinnerReveal({ ...options, count: 144, NicknameMesh }),
    registerTickable,
    ...overrides,
  });
  appRef = app;

  // Keep the status label honest even between connection-state changes.
  if (typeof setInterval !== 'undefined') {
    setInterval(refreshStatus, 1000);
  }

  await app.run();
  return app;
}

/**
 * Whether the module is running under a test runner (vitest sets VITEST/NODE_ENV).
 * Used to suppress the browser auto-bootstrap when the property tests import this
 * module to drive `createLotteryApp` directly.
 * @returns {boolean}
 */
function isTestEnvironment() {
  return (
    typeof process !== 'undefined' &&
    !!process.env &&
    (process.env.VITEST === 'true' || process.env.VITEST === '1' || process.env.NODE_ENV === 'test')
  );
}

// Auto-bootstrap only in a real browser (never under test, where `three` and the
// pinned addon URLs cannot resolve). The property test for Requirement 6.2 imports
// this module and calls createLotteryApp with a mocked fetch + stub scene instead.
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !isTestEnvironment()) {
  const run = () => {
    bootstrap().catch((err) => {
      // eslint-disable-next-line no-console
      if (typeof console !== 'undefined') console.error('[lottery] bootstrap failed:', err);
      const overlay = document.getElementById('error-overlay');
      if (overlay) overlay.hidden = false;
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}

export default createLotteryApp;
