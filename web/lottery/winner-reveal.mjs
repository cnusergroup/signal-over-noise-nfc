// Feature: after-party-lottery — winner "Signal" reveal animation for the 3D
// lottery (Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7; design §2.3).
//
// The WinnerReveal class drives the dramatic moment when a drawn participant's
// noise dissolves into a clear "signal":
//
//   revealWinner(mesh, allMeshes)
//     1. Tween the winner's noise `uIntensity` from 1.0 → 0.0 over 1.5 s so the
//        wrapping particle cloud dissolves (Requirement 8.3).
//     2. Scale the winner from 1.0× → 3.5× (>= 3× base, Requirement 8.4).
//     3. Lerp the winner's text color to cyan #7df9ff (Requirement 8.4).
//     4. Lift the winner's Y position by `sphereRadius(N)` so it floats above the
//        sphere center (Requirement 8.4).
//     5. Dim every OTHER mesh's text opacity to 0.2 to focus the audience
//        (Requirement 8.5). The winner itself stays at full opacity (1.0).
//     6. Hold the revealed state for at least 8 s before the next draw is
//        accepted (Requirement 8.6) — tracked here and gated by the reveal queue.
//
//   restorePrevious(prevMesh, allMeshes)
//     Returns a previously-revealed winner to the sphere at 50% opacity, restores
//     every other mesh to full opacity, and re-applies the noise (`uIntensity`
//     1.0) to ALL elements (Requirement 8.7). `revealWinner` calls this
//     automatically for the prior winner before starting a new reveal, so calling
//     `revealWinner` twice in a row produces the correct hand-off.
//
//   revealUnknownWinner(nickname, allMeshes)
//     Unknown-winner case (Requirement 8.2): the drawn nickname matched no mesh in
//     the sphere, so a fresh NicknameMesh is created at the sphere center, added to
//     the scene, and revealed like any other winner.
//
// Driveability / testability: this module deliberately does NOT import `three` or
// the pinned Three.js addon URLs. Mirroring letter-formation.mjs, it only reads
// and writes mesh state through the NicknameMesh API (`setIntensity`, `setOpacity`,
// `setColor`, `setScale`, `setPosition`, and the `material`/`scale`/`position`/
// `intensity` getters). This keeps it importable in a plain Node environment, so
// the reveal-phase property test (task 9.7) can construct meshes and drive the
// animation to its exact terminal frame via repeated `update(dt)` ticks without a
// WebGL renderer. Creation of the unknown-winner mesh is injected (a `createMesh`
// factory or a `NicknameMesh` class) rather than statically imported, so the
// `three`-dependent construction lives with the caller (main.mjs in the browser).

import { sphereRadius } from './sphere.mjs';

/** Reveal target cyan color #7df9ff (Requirement 8.4). */
export const WINNER_COLOR = 0x7df9ff;
/** Reveal target color split into 8-bit channels for the in-flight color lerp. */
const WINNER_COLOR_255 = [0x7d, 0xf9, 0xff]; // [125, 249, 255]
/** Base text color used as a restore fallback (matches NicknameMesh DEFAULT_TEXT_COLOR). */
const DEFAULT_TEXT_COLOR = 0xeaffff;

/** Default noise-dissolve + grow/color/lift tween duration in seconds (Requirement 8.3). */
export const DEFAULT_REVEAL_DURATION_S = 1.5;
/** Default minimum hold of the revealed state in milliseconds (Requirement 8.6). */
export const DEFAULT_HOLD_MS = 8000;
/** Winner target scale: >= 3× base (Requirement 8.4). */
export const DEFAULT_TARGET_SCALE = 3.5;
/** Opacity applied to every non-winner mesh during a reveal (Requirement 8.5). */
export const DEFAULT_DIM_OPACITY = 0.2;
/** Opacity a previously-revealed winner returns to in the sphere (Requirement 8.7). */
export const DEFAULT_PREV_OPACITY = 0.5;

/**
 * Drives the winner "signal" reveal and the restore of a previous winner.
 */
export class WinnerReveal {
  /**
   * @param {object} [options]
   * @param {{ add: (mesh: object) => void, remove?: (mesh: object) => void }} [options.scene]
   *   The Scene (or compatible) used to add an unknown-winner mesh to the graph.
   * @param {object} [options.font] - A loaded FontLoader font, forwarded to the
   *   default NicknameMesh constructor when creating an unknown-winner mesh.
   * @param {(nickname: string) => object} [options.createMesh] - Factory that builds
   *   a NicknameMesh-like object for the unknown-winner case. Injected so this
   *   module need not import the `three`-dependent nickname-mesh module.
   * @param {new (nickname: string, font: object, opts?: object) => object} [options.NicknameMesh]
   *   Optional NicknameMesh class used to build the unknown-winner mesh when no
   *   `createMesh` factory is supplied.
   * @param {object} [options.meshOptions] - Options forwarded to the NicknameMesh
   *   constructor for the unknown-winner mesh.
   * @param {number} [options.count] - Explicit participant count `N` for the
   *   `sphereRadius(N)` lift. Defaults to `allMeshes.length` per reveal.
   * @param {number} [options.revealDurationS=1.5] - Reveal tween duration (seconds).
   * @param {number} [options.holdMs=8000] - Minimum revealed-state hold (ms).
   * @param {number} [options.winnerColor=0x7df9ff] - Reveal target color.
   * @param {number} [options.targetScale=3.5] - Winner target scale (>= 3).
   * @param {number} [options.dimOpacity=0.2] - Non-winner opacity during a reveal.
   * @param {number} [options.prevOpacity=0.5] - Previous-winner opacity on restore.
   */
  constructor(options = {}) {
    const {
      scene = null,
      font = null,
      createMesh = null,
      NicknameMesh = null,
      meshOptions = {},
      count = null,
      revealDurationS = DEFAULT_REVEAL_DURATION_S,
      holdMs = DEFAULT_HOLD_MS,
      winnerColor = WINNER_COLOR,
      targetScale = DEFAULT_TARGET_SCALE,
      dimOpacity = DEFAULT_DIM_OPACITY,
      prevOpacity = DEFAULT_PREV_OPACITY,
    } = options;

    this.scene = scene;
    this.font = font;
    this.createMesh = typeof createMesh === 'function' ? createMesh : null;
    this.NicknameMeshClass = typeof NicknameMesh === 'function' ? NicknameMesh : null;
    this.meshOptions = meshOptions || {};

    this.count = Number.isFinite(count) ? count : null;
    this.revealDurationS = Math.max(0, revealDurationS);
    this.holdMs = Math.max(0, holdMs);
    this.winnerColor = winnerColor;
    this.targetScale = targetScale;
    this.dimOpacity = clamp01(dimOpacity);
    this.prevOpacity = clamp01(prevOpacity);

    /**
     * Active reveal state, or null when idle. Shape:
     *   { mesh, others:[{mesh,startOpacity}], elapsed, holdElapsed, duration,
     *     startScale, startIntensity, startColor255, startPos:{x,y,z}, targetY,
     *     tweenDone }
     * @type {?object}
     */
    this._reveal = null;

    /** The most recently revealed winner mesh (the "previous" winner). @type {?object} */
    this._lastWinner = null;
    /** Pre-reveal snapshot of the last winner, used to restore it. @type {?object} */
    this._lastSnapshot = null;
    /** Meshes created by this class for unknown winners (so they can be cleaned up). @type {Set<object>} */
    this._createdMeshes = new Set();
  }

  /** True while the dissolve/grow/color/lift tween is still running. @returns {boolean} */
  get isRevealing() {
    return !!this._reveal && !this._reveal.tweenDone;
  }

  /** True once the reveal tween has finished and the hold is in progress. @returns {boolean} */
  get isHolding() {
    return !!this._reveal && this._reveal.tweenDone;
  }

  /** The currently revealed winner mesh, or null. @returns {?object} */
  get currentWinnerMesh() {
    return this._reveal ? this._reveal.mesh : null;
  }

  /** Milliseconds elapsed in the post-tween hold. @returns {number} */
  get holdElapsedMs() {
    return this._reveal && this._reveal.tweenDone ? this._reveal.holdElapsed * 1000 : 0;
  }

  /**
   * Whether the minimum 8 s hold has elapsed since the reveal tween completed, so
   * the next draw result may be accepted (Requirement 8.6). Idle counts as true.
   * @returns {boolean}
   */
  isHoldComplete() {
    if (!this._reveal) return true;
    return this._reveal.tweenDone && this._reveal.holdElapsed * 1000 >= this.holdMs;
  }

  /**
   * Begin the winner reveal for `mesh`. If a different winner was revealed
   * previously, it is first returned to the sphere via {@link restorePrevious}
   * (Requirement 8.7) so the hand-off state is correct before the new reveal.
   *
   * @param {object} mesh - The winning NicknameMesh (or compatible) to reveal.
   * @param {Array<object>} [allMeshes=[]] - Every nickname mesh currently in the
   *   sphere. The winner may or may not be a member (unknown-winner case).
   * @returns {object} The reveal state that `update(dt)` advances.
   */
  revealWinner(mesh, allMeshes = []) {
    if (!mesh) {
      throw new Error('WinnerReveal.revealWinner requires a winner mesh.');
    }
    const meshes = Array.isArray(allMeshes) ? allMeshes : [];

    // Hand off the previous winner back to the sphere before the new reveal.
    if (this._lastWinner && this._lastWinner !== mesh) {
      this.restorePrevious(this._lastWinner, meshes);
    }

    // Capture the winner's pre-reveal state so it can later be restored.
    const startScale = readScale(mesh);
    const startPos = readPosition(mesh);
    const startIntensity = readIntensity(mesh);
    const snapshot = {
      scale: startScale,
      color: readColorHex(mesh, DEFAULT_TEXT_COLOR),
      intensity: startIntensity,
      position: { x: startPos.x, y: startPos.y, z: startPos.z },
    };

    // N for the lift height. Default to the sphere participant count.
    const n = this.count != null ? this.count : meshes.length;
    const lift = sphereRadius(n);

    // Capture each OTHER mesh's current opacity as the dim-tween start.
    const others = [];
    for (const m of meshes) {
      if (m && m !== mesh) {
        others.push({ mesh: m, startOpacity: readOpacity(m) });
      }
    }

    // The winner stays fully opaque throughout the reveal (Requirement 8.4/8.6).
    if (typeof mesh.setOpacity === 'function') mesh.setOpacity(1.0);

    this._reveal = {
      mesh,
      others,
      elapsed: 0,
      holdElapsed: 0,
      duration: this.revealDurationS,
      startScale,
      startIntensity,
      startColor255: readColor255(mesh),
      startPos,
      targetY: startPos.y + lift,
      tweenDone: false,
    };

    this._lastWinner = mesh;
    this._lastSnapshot = snapshot;

    // Settle zero-duration reveals immediately so callers that never tick still
    // observe the terminal frame.
    if (this._reveal.duration === 0) {
      this.update(0);
    }

    return this._reveal;
  }

  /**
   * Unknown-winner case (Requirement 8.2): create a new NicknameMesh for the drawn
   * nickname at the sphere center, add it to the scene, and reveal it.
   *
   * Requires either a `createMesh` factory or a `NicknameMesh` class to have been
   * supplied to the constructor (so this module avoids a static `three` import).
   *
   * @param {string} nickname - The drawn nickname that matched no existing mesh.
   * @param {Array<object>} [allMeshes=[]] - Every nickname mesh in the sphere; all
   *   are dimmed to focus on the new signal.
   * @returns {object} The freshly created and now-revealing mesh.
   */
  revealUnknownWinner(nickname, allMeshes = []) {
    const mesh = this._makeMesh(nickname);
    if (typeof mesh.setPosition === 'function') mesh.setPosition(0, 0, 0);
    if (this.scene && typeof this.scene.add === 'function') {
      this.scene.add(mesh);
    }
    this._createdMeshes.add(mesh);
    this.revealWinner(mesh, allMeshes);
    return mesh;
  }

  /**
   * Return a previously-revealed winner to the sphere and re-noise the field
   * (Requirement 8.7):
   *   - the previous winner's text opacity is set to 0.5;
   *   - every other mesh's opacity is restored to 1.0;
   *   - EVERY mesh's noise `uIntensity` is restored to 1.0 (re-apply Noise_Effect);
   *   - the previous winner's reveal transforms (scale, color, position) are
   *     restored toward their pre-reveal values.
   *
   * @param {object} prevMesh - The previously-revealed winner mesh.
   * @param {Array<object>} [allMeshes=[]] - Every nickname mesh in the sphere.
   * @param {object} [snapshot] - Optional pre-reveal snapshot of `prevMesh`.
   *   Defaults to the snapshot captured when `prevMesh` was revealed.
   * @returns {this}
   */
  restorePrevious(prevMesh, allMeshes = [], snapshot) {
    const meshes = Array.isArray(allMeshes) ? allMeshes : [];

    // Re-apply noise to all elements and restore non-winner opacity to full.
    for (const m of meshes) {
      if (!m) continue;
      if (typeof m.setIntensity === 'function') m.setIntensity(1.0);
      if (typeof m.setOpacity === 'function') {
        m.setOpacity(m === prevMesh ? this.prevOpacity : 1.0);
      }
    }

    // Restore the previous winner itself (it may not be a member of `allMeshes`,
    // e.g. an unknown-winner mesh), bringing it back into the sphere at 50%.
    if (prevMesh) {
      const snap =
        snapshot ||
        (prevMesh === this._lastWinner ? this._lastSnapshot : null);

      if (typeof prevMesh.setIntensity === 'function') prevMesh.setIntensity(1.0);
      if (typeof prevMesh.setScale === 'function') prevMesh.setScale(snap ? snap.scale : 1.0);
      if (typeof prevMesh.setColor === 'function') prevMesh.setColor(snap ? snap.color : DEFAULT_TEXT_COLOR);
      if (snap && snap.position && typeof prevMesh.setPosition === 'function') {
        prevMesh.setPosition(snap.position.x, snap.position.y, snap.position.z);
      }
      if (typeof prevMesh.setOpacity === 'function') prevMesh.setOpacity(this.prevOpacity);
    }

    return this;
  }

  /**
   * Advance the active reveal by `dt` seconds. Drives the dissolve/grow/color/lift
   * tween to its exact terminal frame, then accumulates the post-reveal hold time.
   * Called each frame by the owning render loop (main.mjs, task 10.3).
   * @param {number} dt - Seconds since the previous frame.
   */
  update(dt) {
    const r = this._reveal;
    if (!r) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    if (!r.tweenDone) {
      r.elapsed += step;
      const t = r.duration <= 0 ? 1 : Math.min(1, r.elapsed / r.duration);
      const e = smoothstep(t);

      // Winner: dissolve noise, grow, recolor toward cyan, lift on Y.
      setIfFn(r.mesh, 'setIntensity', lerp(r.startIntensity, 0, e));
      setIfFn(r.mesh, 'setScale', lerp(r.startScale, this.targetScale, e));
      applyColorLerp(r.mesh, r.startColor255, WINNER_COLOR_255, e);
      if (typeof r.mesh.setPosition === 'function') {
        r.mesh.setPosition(r.startPos.x, lerp(r.startPos.y, r.targetY, e), r.startPos.z);
      }

      // Every other mesh: dim toward 0.2.
      for (const o of r.others) {
        setIfFn(o.mesh, 'setOpacity', lerp(o.startOpacity, this.dimOpacity, e));
      }

      if (t >= 1) {
        // Snap to exact terminal values so assertions land precisely.
        setIfFn(r.mesh, 'setIntensity', 0);
        setIfFn(r.mesh, 'setScale', this.targetScale);
        if (typeof r.mesh.setColor === 'function') r.mesh.setColor(this.winnerColor);
        if (typeof r.mesh.setPosition === 'function') {
          r.mesh.setPosition(r.startPos.x, r.targetY, r.startPos.z);
        }
        setIfFn(r.mesh, 'setOpacity', 1.0); // winner remains fully opaque
        for (const o of r.others) {
          setIfFn(o.mesh, 'setOpacity', this.dimOpacity);
        }
        r.tweenDone = true;
      }
    } else {
      // Post-reveal hold (Requirement 8.6).
      r.holdElapsed += step;
    }
  }

  /**
   * Clear the active reveal without restoring anything. The reveal queue calls
   * this once the hold elapses and there is no next winner queued.
   * @returns {this}
   */
  clear() {
    this._reveal = null;
    return this;
  }

  /**
   * Build a NicknameMesh-like object for the unknown-winner case using the injected
   * factory or class.
   * @param {string} nickname
   * @returns {object}
   * @private
   */
  _makeMesh(nickname) {
    if (this.createMesh) return this.createMesh(nickname);
    if (this.NicknameMeshClass) return new this.NicknameMeshClass(nickname, this.font, this.meshOptions);
    throw new Error(
      'WinnerReveal.revealUnknownWinner requires a `createMesh` factory or a `NicknameMesh` class in the constructor.',
    );
  }
}

/**
 * Lerp a mesh's text color from one 8-bit RGB snapshot toward another and apply it
 * via `setColor`. Used only for the in-flight transition; the terminal frame sets
 * the exact target color directly so it equals THREE.Color(#7df9ff).
 * @param {object} mesh
 * @param {[number, number, number]} from255
 * @param {[number, number, number]} to255
 * @param {number} e - Eased progress in [0, 1].
 */
function applyColorLerp(mesh, from255, to255, e) {
  if (typeof mesh.setColor !== 'function') return;
  const r = clampByte(Math.round(lerp(from255[0], to255[0], e)));
  const g = clampByte(Math.round(lerp(from255[1], to255[1], e)));
  const b = clampByte(Math.round(lerp(from255[2], to255[2], e)));
  mesh.setColor((r << 16) | (g << 8) | b);
}

/**
 * Read a mesh's current text color as an 8-bit `[r, g, b]` triple, defaulting to
 * the base text color when unreadable.
 * @param {object} mesh
 * @returns {[number, number, number]}
 */
function readColor255(mesh) {
  const c = mesh && mesh.material && mesh.material.color;
  if (c && Number.isFinite(c.r)) {
    return [clampByte(Math.round(c.r * 255)), clampByte(Math.round(c.g * 255)), clampByte(Math.round(c.b * 255))];
  }
  return [(DEFAULT_TEXT_COLOR >> 16) & 0xff, (DEFAULT_TEXT_COLOR >> 8) & 0xff, DEFAULT_TEXT_COLOR & 0xff];
}

/**
 * Read a mesh's current text color as a hex integer for snapshot/restore.
 * @param {object} mesh
 * @param {number} fallback
 * @returns {number}
 */
function readColorHex(mesh, fallback) {
  const c = mesh && mesh.material && mesh.material.color;
  if (c && typeof c.getHex === 'function') return c.getHex();
  if (c && Number.isFinite(c.r)) {
    return (clampByte(Math.round(c.r * 255)) << 16) |
      (clampByte(Math.round(c.g * 255)) << 8) |
      clampByte(Math.round(c.b * 255));
  }
  return fallback;
}

/**
 * Read a mesh's current uniform scale (its `scale.x`), defaulting to 1.
 * @param {object} mesh
 * @returns {number}
 */
function readScale(mesh) {
  const s = mesh && mesh.scale;
  if (s && Number.isFinite(s.x)) return s.x;
  return 1;
}

/**
 * Read a mesh's current position as a plain `{ x, y, z }`, defaulting to origin.
 * @param {object} mesh
 * @returns {{ x: number, y: number, z: number }}
 */
function readPosition(mesh) {
  const p = mesh && mesh.position;
  if (p && Number.isFinite(p.x)) return { x: p.x, y: p.y, z: p.z };
  return { x: 0, y: 0, z: 0 };
}

/**
 * Read a mesh's current noise intensity, defaulting to 1.
 * @param {object} mesh
 * @returns {number}
 */
function readIntensity(mesh) {
  if (mesh && Number.isFinite(mesh.intensity)) return mesh.intensity;
  return 1;
}

/**
 * Read a mesh's current text opacity, defaulting to 1.
 * @param {object} mesh
 * @returns {number}
 */
function readOpacity(mesh) {
  const mat = mesh && mesh.material;
  if (mat && Number.isFinite(mat.opacity)) return mat.opacity;
  return 1;
}

/** Call `mesh[fn](value)` when that method exists. */
function setIfFn(mesh, fn, value) {
  if (mesh && typeof mesh[fn] === 'function') mesh[fn](value);
}

/** Linear interpolation between `a` and `b` by `t`. */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Smoothstep ease-in-out: 3t² − 2t³ on the clamped range [0, 1]. */
function smoothstep(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Clamp a number to an integer byte in `[0, 255]`. */
function clampByte(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v | 0;
}

/** Clamp a number to the inclusive range `[0, 1]`. Non-finite inputs collapse to 0. */
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export default WinnerReveal;
