// Feature: after-party-lottery — network client for the 3D lottery big-screen page.
//
// LotteryClient is the only module that talks to the backend. It has two jobs:
//
//   1. loadParticipants() — a one-shot GET /lottery/participants (with a 5 s
//      request timeout) used during the Loading state. It fails fast (throws) on
//      any fetch error, a non-2xx / >= 500 response, or a participant count below
//      the minimum of 10, so the state machine in main.mjs (task 10.2) can enter
//      the Error state and never start the letter-formation sequence
//      (Requirement 6.2 / 9.1).
//
//   2. pollWinners() — the recurring poll of GET /lottery/winners every 3 s while
//      connected and every 5 s while disconnected (Requirements 9.1, 9.3, 9.4).
//      Each successful poll filters out winners whose drawSeq is at or below the
//      monotonic high-water mark `knownDrawSeq`, sorts the remainder ascending,
//      and hands each to `scene.queueReveal(winner)` in chronological draw order
//      (Requirement 9.2).
//
// Connection state machine (Requirements 9.3, 9.4):
//   - `failureStreak` counts consecutive failed polls (network error, abort
//     timeout, or HTTP status >= 500 / !resp.ok). It resets to 0 on every
//     successful poll.
//   - After 3 consecutive failures the client switches to `disconnected`.
//   - The next success switches back to `connected` and resets `failureStreak`.
//   Because `failureStreak` resets on success, `connected === (failureStreak < 3)`
//   always holds, which is exactly "disconnected iff a window of 3 consecutive
//   failures with no later success exists".
//
// The next poll is always scheduled with `currentInterval`, derived purely from
// the connection state: 3000 ms while connected, 5000 ms while disconnected.
//
// `lastSuccessAt` is exposed for the StatusIndicator (task 10.4), which renders
// the "connected" label only when a success arrived within the last 6 s
// (Requirement 9.5).
//
// Network and timing dependencies are injectable through the optional third
// constructor argument so the polling property tests (tasks 10.6, 10.7) can run
// in Node with a mocked fetch and `vi.useFakeTimers()` without touching the DOM.

/** Minimum participant count required to start the animation (Requirement 6.2). */
const DEFAULT_MIN_PARTICIPANTS = 10;
/** Consecutive-failure threshold that flips the client to disconnected (Requirement 9.3). */
const DEFAULT_FAILURE_THRESHOLD = 3;
/** Standard poll cadence while connected (Requirement 9.1). */
const DEFAULT_POLL_INTERVAL_MS = 3000;
/** Retry cadence while disconnected (Requirement 9.3). */
const DEFAULT_DISCONNECTED_INTERVAL_MS = 5000;
/** Per-request timeout enforced via AbortController (Requirement 9.1). */
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/**
 * Fetches the participant list once and polls the winners endpoint on a cadence,
 * tracking connection health and forwarding new winners to the scene.
 */
export class LotteryClient {
  /**
   * @param {string} apiBase - Base URL of the lottery API (no trailing slash),
   *   e.g. `https://api.example.com`. Endpoints are appended directly.
   * @param {{ queueReveal: (winner: object) => void }} scene - The Three.js scene
   *   wrapper. `queueReveal` is invoked once per newly detected winner.
   * @param {object} [options] - Injectable dependencies and tunables (mainly for tests).
   * @param {typeof fetch} [options.fetch] - Fetch implementation. Defaults to the
   *   global `fetch`.
   * @param {() => number} [options.now] - Clock used for `lastSuccessAt`. Defaults
   *   to `Date.now`.
   * @param {number} [options.pollInterval=3000] - Connected poll interval (ms).
   * @param {number} [options.disconnectedInterval=5000] - Disconnected retry interval (ms).
   * @param {number} [options.requestTimeout=5000] - Per-request abort timeout (ms).
   * @param {number} [options.minParticipants=10] - Minimum participants to proceed.
   * @param {number} [options.failureThreshold=3] - Consecutive failures before disconnect.
   * @param {(connected: boolean) => void} [options.onConnectionChange] - Optional
   *   callback fired whenever the connection state flips, used by main.mjs to drive
   *   the StatusIndicator without coupling this client to the DOM.
   */
  constructor(apiBase, scene, options = {}) {
    this.apiBase = apiBase;
    this.scene = scene;

    // --- Connection / draw state (field names match design section 2.4) ------
    /** Monotonic high-water mark: the largest drawSeq already forwarded to the scene. */
    this.knownDrawSeq = 0;
    /** Count of consecutive failed polls; reset to 0 on any success. */
    this.failureStreak = 0;
    /** Poll cadence while connected (ms). */
    this.pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    /** Retry cadence while disconnected (ms). */
    this.disconnectedInterval = options.disconnectedInterval ?? DEFAULT_DISCONNECTED_INTERVAL_MS;
    /** Unix-ms timestamp of the last successful poll; read by the StatusIndicator. */
    this.lastSuccessAt = 0;

    // --- Derived / tunable state ---------------------------------------------
    /** Current connection state. Starts connected (no failures yet). */
    this.connected = true;
    /** Per-request abort timeout (ms). */
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    /** Minimum participants required before the animation may start. */
    this.minParticipants = options.minParticipants ?? DEFAULT_MIN_PARTICIPANTS;
    /** Consecutive-failure count that triggers the disconnected state. */
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    /** Interval (ms) used to schedule the next poll; mirrors the connection state. */
    this.currentInterval = this.pollInterval;

    // --- Injected dependencies ------------------------------------------------
    this._fetch = options.fetch
      ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
    this._now = options.now ?? (() => Date.now());
    this._onConnectionChange = options.onConnectionChange ?? null;

    // --- Scheduling bookkeeping ----------------------------------------------
    this._timerId = null;
    this._stopped = true;
  }

  /**
   * Fetch the participant list once. Resolves with the parsed response body
   * (`{ count, participants }`) on success, and throws (fail-fast) on any of:
   * fetch error, abort timeout, non-2xx / >= 500 status, or a participant count
   * below `minParticipants`. The thrown error carries a `code` of either
   * `fetch_failed` or `too_few_participants` so the caller can distinguish them.
   *
   * @returns {Promise<{ count: number, participants: Array<{ nickname: string }> }>}
   * @throws {Error} When the request fails or returns fewer than the minimum
   *   number of participants.
   */
  async loadParticipants() {
    const url = `${this.apiBase}/lottery/participants`;
    let body;
    try {
      body = await this._fetchJson(url);
    } catch (err) {
      throw withCode(
        new Error(`Failed to load participants: ${err && err.message ? err.message : err}`),
        'fetch_failed',
      );
    }

    const participants = Array.isArray(body.participants) ? body.participants : [];
    const count = typeof body.count === 'number' ? body.count : participants.length;

    if (count < this.minParticipants) {
      throw withCode(
        new Error(
          `Too few participants to start the animation: ${count} < ${this.minParticipants}.`,
        ),
        'too_few_participants',
      );
    }

    return { count, participants };
  }

  /**
   * Begin the recurring poll loop. Idempotent: a no-op if already running.
   * Performs the first poll immediately, then self-schedules subsequent polls.
   * @returns {Promise<void>} Resolves after the first poll completes.
   */
  start() {
    if (!this._stopped) return Promise.resolve();
    this._stopped = false;
    return this.pollWinners();
  }

  /** Stop the poll loop and cancel any pending scheduled poll. Idempotent. */
  stop() {
    this._stopped = true;
    if (this._timerId != null) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }

  /**
   * Perform a single poll of GET /lottery/winners and schedule the next one.
   *
   * On success: reset `failureStreak`, record `lastSuccessAt`, mark connected,
   * then forward every winner with `drawSeq > knownDrawSeq` to the scene in
   * ascending `drawSeq` order, advancing `knownDrawSeq` to the highest applied.
   *
   * On failure (network error, abort timeout, or HTTP `>= 500` / `!resp.ok`):
   * increment `failureStreak`; once it reaches `failureThreshold`, mark
   * disconnected.
   *
   * The next poll is scheduled with `currentInterval`, which is `pollInterval`
   * while connected and `disconnectedInterval` while disconnected.
   *
   * @returns {Promise<void>}
   */
  async pollWinners() {
    await this._pollOnce();
    this._scheduleNext();
  }

  /**
   * The connection-state-derived delay for the next poll: `disconnectedInterval`
   * while disconnected, `pollInterval` while connected.
   * @returns {number} Interval in milliseconds.
   */
  nextInterval() {
    return this.connected ? this.pollInterval : this.disconnectedInterval;
  }

  /**
   * Update the connection state and notify any listener. Does not touch the DOM;
   * main.mjs wires `onConnectionChange` to the StatusIndicator.
   * @param {boolean} connected - The new connection state.
   */
  setConnected(connected) {
    const changed = this.connected !== connected;
    this.connected = connected;
    if (changed && typeof this._onConnectionChange === 'function') {
      this._onConnectionChange(connected);
    }
  }

  // --- Internal helpers -------------------------------------------------------

  /**
   * Execute one poll without scheduling the next, updating the connection state
   * machine. Never rejects: failures are folded into `failureStreak`.
   * @returns {Promise<void>}
   * @private
   */
  async _pollOnce() {
    try {
      const body = await this._fetchJson(`${this.apiBase}/lottery/winners`);
      const winners = Array.isArray(body.winners) ? body.winners : [];
      this._onPollSuccess(winners);
    } catch {
      this._onPollFailure();
    }
  }

  /**
   * Apply a successful poll result: reset the failure streak, record the success
   * time, mark connected, and forward newly drawn winners to the scene.
   * @param {Array<{ drawSeq: number, nickname: string }>} winners
   * @private
   */
  _onPollSuccess(winners) {
    this.failureStreak = 0;
    this.lastSuccessAt = this._now();
    this.setConnected(true);

    const newWinners = winners
      .filter((w) => w && typeof w.drawSeq === 'number' && w.drawSeq > this.knownDrawSeq)
      .sort((a, b) => a.drawSeq - b.drawSeq);

    for (const winner of newWinners) {
      this.scene.queueReveal(winner);
      this.knownDrawSeq = winner.drawSeq;
    }
  }

  /**
   * Apply a failed poll: increment the streak and switch to disconnected once it
   * reaches the threshold.
   * @private
   */
  _onPollFailure() {
    this.failureStreak += 1;
    if (this.failureStreak >= this.failureThreshold) {
      this.setConnected(false);
    }
  }

  /**
   * Schedule the next poll using the connection-state-derived interval, unless
   * the loop has been stopped.
   * @private
   */
  _scheduleNext() {
    if (this._stopped) return;
    this.currentInterval = this.nextInterval();
    this._timerId = setTimeout(() => {
      this.pollWinners();
    }, this.currentInterval);
  }

  /**
   * GET `url` as JSON with a `requestTimeout` abort guard. Rejects on fetch
   * error, abort, or a `!resp.ok` / `>= 500` status (both treated as failures).
   * @param {string} url
   * @returns {Promise<object>} The parsed JSON body.
   * @private
   */
  async _fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeout);
    try {
      const resp = await this._fetch(url, { signal: controller.signal });
      if (!resp.ok || resp.status >= 500) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Attach a machine-readable `code` to an Error and return it.
 * @param {Error} err
 * @param {string} code
 * @returns {Error}
 */
function withCode(err, code) {
  err.code = code;
  return err;
}

export default LotteryClient;
