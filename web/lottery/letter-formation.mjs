// Feature: after-party-lottery — letter-formation positioning + tweening for the
// 3D lottery animation (Requirements 6.3, 6.4, 6.5, 6.6).
//
// The LetterFormation class arranges a fixed set of NicknameMesh instances so they
// spell out one of the letters "A", "W", or "S" in 3D space, then tweens each mesh
// from its current position to its computed target over a configurable duration
// (default 2 s, per Requirements 6.3/6.4/6.5). `dispersToOpacityZero()` fades the
// currently-formed letter to opacity 0 so the previous letter disperses before the
// next one begins forming (Requirement 6.6). The owning state machine (task 10.2)
// sequences disperse → form → hold across A → W → S.
//
// Target positions come from sampling a 40×60 bitmap of the glyph (design §2.5):
//   1. Render the glyph with a fat (heavy-weight) font into a hidden <canvas>,
//      read the pixels, and collect the filled (x, y) coordinates.
//   2. Deduplicate and shuffle those coordinates, then map each to world space
//      `(x_norm * width, y_norm * height, 0)` with `width = 18`, `height = 24`.
//   3. If there are MORE meshes than filled pixels, the extras are placed at a
//      small random offset BEHIND the letter (negative z + xy jitter). If FEWER,
//      only the first N shuffled pixels are used, which uniformly subsamples the
//      glyph and keeps the shape recognizable for any count between 10 and 500.
//
// Testability / environment guard: in a Node or JSDOM test environment there is no
// real 2D canvas raster (`canvas.getContext('2d')` returns null, or `getImageData`
// is unavailable). The glyph sampler detects this and falls back to a deterministic
// line-segment rasterizer for A/W/S, so the module can be constructed and exercised
// without a GPU or the optional `canvas` package. The canvas path is preferred when
// available (the real browser big-screen display).
//
// This module intentionally does NOT import `three`: it only reads/writes mesh state
// through the NicknameMesh API (`position`, `material`, `setPosition`, `setOpacity`),
// which keeps it importable in JSDOM/Node where the pinned Three.js addon URLs in
// nickname-mesh.mjs cannot resolve.

/** Hidden-canvas bitmap width used to sample each glyph (design §2.5). */
export const GRID_W = 40;
/** Hidden-canvas bitmap height used to sample each glyph (design §2.5). */
export const GRID_H = 60;
/** World-space width the letter spans on the X axis (design §2.5). */
export const LETTER_WIDTH = 18;
/** World-space height the letter spans on the Y axis (design §2.5). */
export const LETTER_HEIGHT = 24;
/** Default tween duration, in seconds, for forming a letter (Requirements 6.3–6.5). */
export const DEFAULT_FORM_DURATION = 2;
/** Default tween duration, in seconds, for dispersing a letter to opacity 0 (Requirement 6.6). */
export const DEFAULT_DISPERSE_DURATION = 1;
/** Alpha threshold (0–255) above which a sampled canvas pixel counts as "filled". */
const ALPHA_THRESHOLD = 128;
/** Letters supported by the formation sequence. */
const SUPPORTED_LETTERS = new Set(['A', 'W', 'S']);

/**
 * Arranges and tweens a set of NicknameMesh instances into the letters A, W, S.
 */
export class LetterFormation {
  /**
   * @param {Array<object>} [meshes=[]] - The NicknameMesh instances to arrange.
   *   Each must expose `position` (a `{x, y, z}` vector), `material` (with an
   *   `opacity` number), `setPosition(x, y, z)`, and `setOpacity(v)`.
   * @param {object} [options]
   * @param {number} [options.gridW=GRID_W] - Glyph sampling bitmap width.
   * @param {number} [options.gridH=GRID_H] - Glyph sampling bitmap height.
   * @param {number} [options.width=LETTER_WIDTH] - World width the letter spans.
   * @param {number} [options.height=LETTER_HEIGHT] - World height the letter spans.
   * @param {number} [options.formDuration=DEFAULT_FORM_DURATION] - Default form tween seconds.
   * @param {number} [options.disperseDuration=DEFAULT_DISPERSE_DURATION] - Default disperse seconds.
   * @param {() => number} [options.random=Math.random] - Injectable RNG (shuffle + jitter).
   * @param {Document} [options.documentRef] - Document used to create the hidden canvas
   *   (defaults to the global `document` when present).
   * @param {string} [options.fontFamily] - Fat font family list for canvas rendering.
   */
  constructor(meshes = [], options = {}) {
    const {
      gridW = GRID_W,
      gridH = GRID_H,
      width = LETTER_WIDTH,
      height = LETTER_HEIGHT,
      formDuration = DEFAULT_FORM_DURATION,
      disperseDuration = DEFAULT_DISPERSE_DURATION,
      random = Math.random,
      documentRef = (typeof document !== 'undefined' ? document : null),
      fontFamily = '"Arial Black", "Helvetica Neue", Arial, sans-serif',
    } = options;

    /** @type {Array<object>} */
    this.meshes = Array.isArray(meshes) ? meshes.slice() : [];
    this.gridW = gridW;
    this.gridH = gridH;
    this.width = width;
    this.height = height;
    this.formDuration = formDuration;
    this.disperseDuration = disperseDuration;
    this.random = typeof random === 'function' ? random : Math.random;
    this.documentRef = documentRef;
    this.fontFamily = fontFamily;

    /** The letter currently being formed / held, or null. @type {?string} */
    this.currentLetter = null;

    /**
     * The active tween, or null when idle. Shape:
     *   { type, meshes, from?, to?, fromOpacity?, toOpacity?, elapsed, duration,
     *     done, onComplete?, resolve? }
     * @type {?object}
     */
    this._active = null;
  }

  /**
   * Replace the meshes this formation arranges. Interrupts any active tween.
   * @param {Array<object>} meshes
   * @returns {this}
   */
  setMeshes(meshes) {
    this.meshes = Array.isArray(meshes) ? meshes.slice() : [];
    this._active = null;
    return this;
  }

  /** Whether a form/disperse tween is currently in progress. @returns {boolean} */
  get isAnimating() {
    return !!this._active && !this._active.done;
  }

  /**
   * Compute world-space target positions that arrange `count` meshes into `letter`.
   *
   * Filled glyph pixels are deduplicated and shuffled, then mapped to world space.
   * Extra meshes (count > filled pixels) are placed behind the letter; when fewer,
   * only the first `count` shuffled pixels are used.
   *
   * @param {'A'|'W'|'S'} letter - Target glyph.
   * @param {number} count - Number of target positions to produce.
   * @returns {Array<[number, number, number]>} `count` `[x, y, z]` world targets.
   */
  computeTargets(letter, count) {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return [];

    const pixels = sampleGlyphPixels(letter, {
      gridW: this.gridW,
      gridH: this.gridH,
      doc: this.documentRef,
      fontFamily: this.fontFamily,
    });

    const worldPixels = shuffle(pixels, this.random).map((p) =>
      pixelToWorld(p, this.gridW, this.gridH, this.width, this.height),
    );

    // Degenerate guard: if sampling produced nothing, cluster around the origin so
    // the animation still has finite targets rather than NaN positions.
    if (worldPixels.length === 0) {
      const fallback = [];
      for (let i = 0; i < n; i++) {
        fallback.push([
          (this.random() - 0.5) * this.width,
          (this.random() - 0.5) * this.height,
          0,
        ]);
      }
      return fallback;
    }

    const targets = [];
    if (n <= worldPixels.length) {
      // Fewer meshes than pixels: use the first N shuffled pixels (uniform subsample).
      for (let i = 0; i < n; i++) {
        targets.push(worldPixels[i].slice());
      }
    } else {
      // One mesh per pixel, then extras tucked behind the letter (design §2.5).
      for (let i = 0; i < worldPixels.length; i++) {
        targets.push(worldPixels[i].slice());
      }
      for (let i = worldPixels.length; i < n; i++) {
        const base = worldPixels[i % worldPixels.length];
        const jitterX = (this.random() - 0.5) * 2; // ±1 world unit
        const jitterY = (this.random() - 0.5) * 2; // ±1 world unit
        const zBehind = -(1 + this.random() * 3); // 1–4 units behind the glyph plane
        targets.push([base[0] + jitterX, base[1] + jitterY, zBehind]);
      }
    }
    return targets;
  }

  /**
   * Begin tweening the meshes from their current positions to the target positions
   * that form `letter`. Resolves (and calls `onComplete`) when the tween finishes.
   *
   * @param {'A'|'W'|'S'} letter - Target glyph.
   * @param {object} [options]
   * @param {number} [options.duration] - Tween seconds (defaults to `formDuration`).
   * @param {boolean} [options.resetOpacity=true] - Restore each mesh to opacity 1 at
   *   the start so the freshly forming letter is visible (after a prior disperse).
   * @param {() => void} [options.onComplete] - Called once the tween reaches its end.
   * @returns {Promise<void>} Resolves when the tween completes.
   */
  formLetter(letter, options = {}) {
    const key = normalizeLetter(letter);
    const {
      duration = this.formDuration,
      resetOpacity = true,
      onComplete,
    } = options;

    this.currentLetter = key;

    const meshes = this.meshes;
    if (meshes.length === 0) {
      if (typeof onComplete === 'function') onComplete();
      return Promise.resolve();
    }

    if (resetOpacity) {
      for (const mesh of meshes) {
        if (typeof mesh.setOpacity === 'function') mesh.setOpacity(1);
      }
    }

    const to = this.computeTargets(key, meshes.length);
    const from = meshes.map((m) => readPosition(m));

    return this._beginTween({
      type: 'position',
      meshes,
      from,
      to,
      duration,
      onComplete,
    });
  }

  /**
   * Fade the currently-formed letter to opacity 0 so it disperses before the next
   * letter forms (Requirement 6.6). Positions are left unchanged.
   *
   * @param {object} [options]
   * @param {number} [options.duration] - Tween seconds (defaults to `disperseDuration`).
   * @param {() => void} [options.onComplete] - Called once the fade completes.
   * @returns {Promise<void>} Resolves when the fade completes.
   */
  dispersToOpacityZero(options = {}) {
    const { duration = this.disperseDuration, onComplete } = options;

    const meshes = this.meshes;
    if (meshes.length === 0) {
      if (typeof onComplete === 'function') onComplete();
      return Promise.resolve();
    }

    const fromOpacity = meshes.map((m) => readOpacity(m));

    return this._beginTween({
      type: 'opacity',
      meshes,
      fromOpacity,
      toOpacity: 0,
      duration,
      onComplete,
    });
  }

  /**
   * Advance the active tween by `dt` seconds. Called each frame by the Scene render
   * loop (the Scene ticks any added object exposing `update(dt)`).
   * @param {number} dt - Seconds since the previous frame.
   */
  update(dt) {
    const a = this._active;
    if (!a || a.done) return;

    a.elapsed += Math.max(0, dt || 0);
    const t = a.duration <= 0 ? 1 : Math.min(1, a.elapsed / a.duration);
    const e = smoothstep(t);

    if (a.type === 'position') {
      for (let i = 0; i < a.meshes.length; i++) {
        const f = a.from[i];
        const to = a.to[i];
        a.meshes[i].setPosition(
          lerp(f[0], to[0], e),
          lerp(f[1], to[1], e),
          lerp(f[2], to[2], e),
        );
      }
    } else {
      for (let i = 0; i < a.meshes.length; i++) {
        a.meshes[i].setOpacity(lerp(a.fromOpacity[i], a.toOpacity, e));
      }
    }

    if (t >= 1) {
      a.done = true;
      this._active = null;
      if (typeof a.onComplete === 'function') a.onComplete();
      if (typeof a.resolve === 'function') a.resolve();
    }
  }

  /**
   * Jump the active tween straight to its final frame and resolve it. Useful when a
   * caller needs the formation to settle immediately (e.g. skipping an animation).
   */
  finish() {
    const a = this._active;
    if (!a || a.done) return;
    a.elapsed = a.duration;
    this.update(0);
  }

  /**
   * Install a tween as the active animation, returning a promise that resolves when
   * `update` drives it to completion. Replaces any in-progress tween.
   * @param {object} tween
   * @returns {Promise<void>}
   * @private
   */
  _beginTween(tween) {
    const active = {
      ...tween,
      elapsed: 0,
      duration: Math.max(0, Number.isFinite(tween.duration) ? tween.duration : 0),
      done: false,
      resolve: null,
    };
    this._active = active;

    const promise = new Promise((resolve) => {
      active.resolve = resolve;
    });

    // Zero-duration tweens settle on the next update tick; nudge them so callers
    // that never call update() (rare) still see the final state applied promptly.
    if (active.duration === 0) {
      this.update(0);
    }
    return promise;
  }
}

/**
 * Sample the filled pixels of a glyph from a 40×60 bitmap.
 *
 * Prefers rendering the glyph with a fat font into a hidden 2D canvas and reading
 * back the alpha channel. When no usable canvas is available (Node, JSDOM without
 * the optional `canvas` package), falls back to a deterministic line-segment
 * rasterizer so the module remains constructible and testable.
 *
 * @param {'A'|'W'|'S'} letter - Glyph to sample.
 * @param {object} [options]
 * @param {number} [options.gridW=GRID_W] - Bitmap width.
 * @param {number} [options.gridH=GRID_H] - Bitmap height.
 * @param {Document|null} [options.doc] - Document used to create the canvas.
 * @param {string} [options.fontFamily] - Fat font family list for the canvas path.
 * @returns {Array<[number, number]>} Deduplicated `[x, y]` filled-pixel coordinates.
 */
export function sampleGlyphPixels(letter, options = {}) {
  const key = normalizeLetter(letter);
  const {
    gridW = GRID_W,
    gridH = GRID_H,
    doc = (typeof document !== 'undefined' ? document : null),
    fontFamily = '"Arial Black", "Helvetica Neue", Arial, sans-serif',
  } = options;

  const viaCanvas = sampleGlyphPixelsViaCanvas(key, { gridW, gridH, doc, fontFamily });
  if (viaCanvas && viaCanvas.length > 0) {
    return dedupePixels(viaCanvas);
  }
  return dedupePixels(rasterizeSegments(glyphSegments(key), gridW, gridH));
}

/**
 * Render a glyph into a hidden canvas and read its filled pixels. Returns `null`
 * when no usable 2D raster context is available (so callers can fall back).
 *
 * @param {string} letter
 * @param {{ gridW: number, gridH: number, doc: Document|null, fontFamily: string }} opts
 * @returns {Array<[number, number]>|null}
 */
function sampleGlyphPixelsViaCanvas(letter, { gridW, gridH, doc, fontFamily }) {
  if (!doc || typeof doc.createElement !== 'function') return null;

  let canvas;
  try {
    canvas = doc.createElement('canvas');
  } catch {
    return null;
  }
  if (!canvas) return null;

  canvas.width = gridW;
  canvas.height = gridH;

  let ctx;
  try {
    ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  } catch {
    return null;
  }
  if (!ctx || typeof ctx.getImageData !== 'function' || typeof ctx.fillText !== 'function') {
    return null;
  }

  try {
    ctx.clearRect(0, 0, gridW, gridH);
    const size = Math.floor(gridH * 0.92);
    ctx.font = `900 ${size}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(letter, gridW / 2, gridH / 2);

    const image = ctx.getImageData(0, 0, gridW, gridH);
    const data = image && image.data;
    if (!data || data.length < gridW * gridH * 4) return null;

    const pixels = [];
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const alpha = data[(y * gridW + x) * 4 + 3];
        if (alpha >= ALPHA_THRESHOLD) pixels.push([x, y]);
      }
    }
    return pixels.length > 0 ? pixels : null;
  } catch {
    return null;
  }
}

/**
 * Map a glyph pixel `[px, py]` (bitmap coordinates, y increasing downward) to a
 * centered world-space `[x, y, 0]` position spanning `width` × `height`.
 *
 * @param {[number, number]} pixel - `[px, py]` in `[0, gridW) × [0, gridH)`.
 * @param {number} gridW - Bitmap width.
 * @param {number} gridH - Bitmap height.
 * @param {number} width - World width the letter spans.
 * @param {number} height - World height the letter spans.
 * @returns {[number, number, number]} Centered world position; y is flipped so the
 *   top of the bitmap maps to positive world Y.
 */
export function pixelToWorld([px, py], gridW, gridH, width, height) {
  const denomW = gridW > 1 ? gridW - 1 : 1;
  const denomH = gridH > 1 ? gridH - 1 : 1;
  const cx = px / denomW - 0.5; // [-0.5, 0.5]
  const cy = 0.5 - py / denomH; // flip: top of bitmap → +Y
  return [cx * width, cy * height, 0];
}

/**
 * Stroke definitions (normalized `[0, 1]` coordinates, y increasing downward to
 * match bitmap orientation) used by the canvas-free fallback rasterizer for the
 * three supported letters. Each entry is a polyline `[[x, y], ...]`.
 *
 * @param {'A'|'W'|'S'} letter
 * @returns {Array<Array<[number, number]>>} Polylines approximating the glyph.
 */
export function glyphSegments(letter) {
  const key = normalizeLetter(letter);
  switch (key) {
    case 'A':
      return [
        [[0.10, 0.97], [0.50, 0.05]], // left leg
        [[0.90, 0.97], [0.50, 0.05]], // right leg
        [[0.28, 0.62], [0.72, 0.62]], // crossbar
      ];
    case 'W':
      return [
        [[0.05, 0.05], [0.25, 0.97]], // down 1
        [[0.25, 0.97], [0.50, 0.38]], // up 1
        [[0.50, 0.38], [0.75, 0.97]], // down 2
        [[0.75, 0.97], [0.95, 0.05]], // up 2
      ];
    case 'S':
      return [
        [
          [0.82, 0.14],
          [0.34, 0.08],
          [0.18, 0.28],
          [0.50, 0.48],
          [0.82, 0.66],
          [0.66, 0.92],
          [0.18, 0.86],
        ],
      ];
    default:
      return [];
  }
}

/**
 * Rasterize polylines into a set of filled bitmap pixels with a "fat" stroke width
 * (approximating a heavy font), deduplicating coincident pixels.
 *
 * @param {Array<Array<[number, number]>>} polylines - Normalized `[0,1]` polylines.
 * @param {number} gridW - Bitmap width.
 * @param {number} gridH - Bitmap height.
 * @param {number} [thickness=2] - Half-width of the stroke, in pixels.
 * @returns {Array<[number, number]>} Filled `[x, y]` pixel coordinates.
 */
export function rasterizeSegments(polylines, gridW, gridH, thickness = 2) {
  const filled = new Set();

  const plot = (px, py) => {
    for (let oy = -thickness; oy <= thickness; oy++) {
      for (let ox = -thickness; ox <= thickness; ox++) {
        const x = Math.round(px) + ox;
        const y = Math.round(py) + oy;
        if (x >= 0 && x < gridW && y >= 0 && y < gridH) {
          filled.add(y * gridW + x);
        }
      }
    }
  };

  for (const line of polylines) {
    for (let s = 0; s < line.length - 1; s++) {
      const [nx0, ny0] = line[s];
      const [nx1, ny1] = line[s + 1];
      const x0 = nx0 * (gridW - 1);
      const y0 = ny0 * (gridH - 1);
      const x1 = nx1 * (gridW - 1);
      const y1 = ny1 * (gridH - 1);
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(dist * 2));
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        plot(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
      }
    }
  }

  const pixels = [];
  for (const code of filled) {
    pixels.push([code % gridW, Math.floor(code / gridW)]);
  }
  return pixels;
}

/**
 * Remove duplicate `[x, y]` pixel coordinates, preserving first-seen order.
 * @param {Array<[number, number]>} pixels
 * @returns {Array<[number, number]>}
 */
function dedupePixels(pixels) {
  const seen = new Set();
  const out = [];
  for (const [x, y] of pixels) {
    const key = `${x},${y}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([x, y]);
    }
  }
  return out;
}

/**
 * Fisher–Yates shuffle returning a new array, using an injectable RNG.
 * @template T
 * @param {Array<T>} arr
 * @param {() => number} random
 * @returns {Array<T>}
 */
function shuffle(arr, random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Read a mesh's world position as a plain `[x, y, z]` triple.
 * @param {object} mesh - A NicknameMesh (or compatible mock).
 * @returns {[number, number, number]}
 */
function readPosition(mesh) {
  const p = mesh && mesh.position;
  if (p && Number.isFinite(p.x)) return [p.x, p.y, p.z];
  return [0, 0, 0];
}

/**
 * Read a mesh's current text opacity, defaulting to 1.
 * @param {object} mesh - A NicknameMesh (or compatible mock).
 * @returns {number}
 */
function readOpacity(mesh) {
  const mat = mesh && mesh.material;
  if (mat && Number.isFinite(mat.opacity)) return mat.opacity;
  return 1;
}

/** Linear interpolation between `a` and `b` by `t`. */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Smoothstep easing on `[0, 1]` for a gentle ease-in/ease-out. */
function smoothstep(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Normalize and validate a letter argument to one of the supported glyphs.
 * @param {string} letter
 * @returns {'A'|'W'|'S'}
 */
function normalizeLetter(letter) {
  const key = typeof letter === 'string' ? letter.toUpperCase() : '';
  if (!SUPPORTED_LETTERS.has(key)) {
    throw new Error(`LetterFormation supports only 'A', 'W', 'S'; received: ${String(letter)}`);
  }
  return /** @type {'A'|'W'|'S'} */ (key);
}

export default LetterFormation;
