// Feature: after-party-lottery — connection-status indicator for the lottery big screen.
//
// The StatusIndicator owns the page's #status-indicator overlay element. On each
// poll outcome the lottery client calls `update(now, lastSuccessAt)`, which the
// indicator translates into a "connected" / "disconnected" visual state.
//
// Per Requirement 9.5 the indicator reads as "connected" when the most recent
// successful poll happened within the last 6 seconds (`now - lastSuccessAt <= 6000`)
// and "disconnected" otherwise. The boundary is inclusive at exactly 6000 ms.
//
// The visual styling (pill, glow, leading status dot) lives in lottery.html. The
// dot is a CSS `::before` pseudo-element driven by the element's `color`, so this
// module only swaps the `connected` / `disconnected` class and the Simplified
// Chinese label text — it never touches the dot directly.

/** Window, in milliseconds, within which the connection is considered alive. */
const CONNECTED_WINDOW_MS = 6000;

/** Simplified Chinese label shown while connected. */
const CONNECTED_TEXT = '已连接';

/** Simplified Chinese label shown while disconnected. */
const DISCONNECTED_TEXT = '未连接';

/**
 * Binds to the `#status-indicator` DOM element and reflects the lottery page's
 * connection state as a CSS class and a Simplified Chinese label.
 */
export class StatusIndicator {
  /**
   * @param {object} [options]
   * @param {HTMLElement} [options.element] - The status element. When omitted the
   *   constructor looks up `#status-indicator` via `document.getElementById`.
   *   Tests may inject a stub element so the class can run under jsdom.
   */
  constructor(options = {}) {
    const {
      element = (typeof document !== 'undefined'
        ? document.getElementById('status-indicator')
        : null),
    } = options;

    /**
     * The bound status element, or null when it could not be found. All methods
     * guard against a null element so the indicator degrades gracefully.
     * @type {?HTMLElement}
     */
    this.element = element || null;
  }

  /**
   * Update the indicator from the current time and the timestamp of the last
   * successful poll.
   *
   * Sets the element class to `connected` and the label to "已连接" when
   * `now - lastSuccessAt <= 6000`; otherwise sets the class to `disconnected`
   * and the label to "未连接". The 6000 ms boundary is inclusive.
   *
   * @param {number} now - Current time in Unix epoch milliseconds.
   * @param {number} lastSuccessAt - Timestamp (Unix epoch ms) of the most recent
   *   successful poll response.
   * @returns {boolean} `true` when the resolved state is connected, `false` otherwise.
   */
  update(now, lastSuccessAt) {
    const connected = (now - lastSuccessAt) <= CONNECTED_WINDOW_MS;
    if (connected) {
      this._setConnected();
    } else {
      this._setDisconnected();
    }
    return connected;
  }

  /** Apply the connected class and label. No-op when the element is absent. */
  _setConnected() {
    if (!this.element) return;
    this.element.classList.remove('disconnected');
    this.element.classList.add('connected');
    this.element.textContent = CONNECTED_TEXT;
  }

  /** Apply the disconnected class and label. No-op when the element is absent. */
  _setDisconnected() {
    if (!this.element) return;
    this.element.classList.remove('connected');
    this.element.classList.add('disconnected');
    this.element.textContent = DISCONNECTED_TEXT;
  }
}

export default StatusIndicator;
