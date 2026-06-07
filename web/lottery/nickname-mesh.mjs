// Feature: after-party-lottery — one renderable nickname for the 3D lottery animation.
//
// IMPLEMENTATION NOTE (Canvas-texture text):
//   Earlier this module rendered each nickname with `TextGeometry` + a loaded
//   `FontLoader` typeface (helvetiker). That font contains only Latin glyphs, so
//   CJK nicknames rendered as blank/`????` boxes and the extruded 3D glyphs were
//   illegible at a distance (the A/W/S letter formation could not be read).
//
//   This version draws the (truncated) nickname onto a 2D <canvas> with the
//   browser's native font stack — which supports Chinese, emoji, and any Unicode
//   — and maps that canvas onto a camera-facing plane via THREE.CanvasTexture.
//   Result: crisp, legible names in any language, and recognizable letter
//   formations.
//
// A NicknameMesh still wraps two Three.js objects under a single parent
// THREE.Group (exposed as `.object3d`, the handle the Scene adds to the graph):
//
//   1. A THREE.Mesh — a PlaneGeometry textured with the rendered nickname.
//   2. A THREE.Points noise cloud powered by the NoiseEffect shader material
//      (noise-effect.mjs). At noise intensity 1.0 the cloud veils 40–70% of the
//      text (Requirement 7.2); tweening intensity to 0.0 dissolves the noise into
//      a clear "signal" during the winner reveal.
//
// The public API is unchanged so LetterFormation, SphereFormation, WinnerReveal,
// and main.mjs keep working without edits:
//   setIntensity, setOpacity, setColor, setScale, setPosition, update(dt),
//   lookAt(target), dispose(); getters material / scale / position / intensity;
//   and the exported loadFont() helper (now a no-op resolve — no font file needed).
//
// Three.js core is imported via the bare `three` specifier (resolved by
// lottery.html's importmap). No example/jsm addons are required anymore.

import * as THREE from 'three';

import { truncateNickname } from './truncate.mjs';
import { createNoisePoints, setNoiseIntensity, DEFAULT_NOISE_COLOR } from './noise-effect.mjs';

/**
 * Default tint applied to the (white) text texture. Pure white = no tint, so the
 * baked white-cyan glyph shows as-is. The reveal lerps this toward cyan #7df9ff.
 * @type {number}
 */
export const DEFAULT_TEXT_COLOR = 0xffffff;

/**
 * Default cyan accent (#7df9ff) — kept for API/back-compat with importers.
 * @type {number}
 */
export const DEFAULT_EMISSIVE_COLOR = DEFAULT_NOISE_COLOR;

/** Default world-space height of the rendered nickname plane. */
const DEFAULT_TEXT_SIZE = 1.6;

/**
 * Font stack for canvas text. Prioritizes common Simplified-Chinese system fonts
 * so CJK nicknames render correctly on the event display PC, with sans-serif
 * fallbacks for Latin/emoji.
 * @type {string}
 */
const FONT_STACK =
  '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Hiragino Sans GB", "Segoe UI", system-ui, sans-serif';

/** Canvas rasterization font size (px). Higher = sharper texture; scaled to world via plane size. */
const CANVAS_FONT_PX = 96;
/** Padding (px) around the text in the canvas so the glow is not clipped. */
const CANVAS_PADDING = 28;

/**
 * One participant nickname rendered as a glowing, camera-facing textured plane
 * wrapped in a noise particle cloud.
 */
export class NicknameMesh {
  /**
   * @param {string} nickname - The participant's nickname. Truncated for display
   *   via {@link truncateNickname} (max 20 chars, ellipsis if longer).
   * @param {object} [font] - Unused (kept for signature back-compat with the old
   *   TextGeometry implementation; pass null).
   * @param {object} [options]
   * @param {number} [options.size=1.6] - World-space text height.
   * @param {number} [options.opacity=1.0] - Initial text opacity (clamped to [0, 1]).
   * @param {number} [options.scale=1.0] - Initial uniform scale.
   * @param {number} [options.intensity=1.0] - Initial noise intensity (clamped to [0, 1]).
   * @param {number} [options.color=DEFAULT_TEXT_COLOR] - Initial texture tint.
   * @param {number} [options.noiseColor=DEFAULT_NOISE_COLOR] - Noise particle color.
   * @param {number} [options.noiseCount] - Particle count for the noise cloud.
   * @param {() => number} [options.random=Math.random] - Injectable RNG for the noise cloud.
   * @param {Document} [options.documentRef] - Document used to create the text canvas.
   */
  constructor(nickname, font, options = {}) {
    const {
      size = DEFAULT_TEXT_SIZE,
      opacity = 1.0,
      scale = 1.0,
      intensity = 1.0,
      color = DEFAULT_TEXT_COLOR,
      noiseColor = DEFAULT_NOISE_COLOR,
      noiseCount,
      random = Math.random,
      documentRef = (typeof document !== 'undefined' ? document : null),
    } = options;

    /** The original, untruncated nickname. @type {string} */
    this.nickname = nickname;
    /** The truncated text actually rendered (<= 20 chars). @type {string} */
    this.text = truncateNickname(String(nickname));

    // --- Text plane (CanvasTexture + basic material) -------------------------
    const { texture, aspect } = renderTextTexture(this.text, documentRef);
    /** @type {?THREE.Texture} */
    this.texture = texture;

    const width = size * (aspect || 4);
    const geometry = new THREE.PlaneGeometry(width, size);

    const material = new THREE.MeshBasicMaterial({
      map: texture || null,
      color: new THREE.Color(color),
      transparent: true,
      opacity: clamp01(opacity),
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false, // keep text bright/legible regardless of scene tone mapping
    });

    /** The textured nickname plane. @type {THREE.Mesh} */
    this.mesh = new THREE.Mesh(geometry, material);

    // --- Noise points cloud sized to the text plane --------------------------
    const boxSize = [
      Math.max(1, width),
      Math.max(1, size),
      Math.max(0.6, size * 0.5),
    ];

    /** The noise particle cloud wrapping the text. @type {THREE.Points} */
    this.points = createNoisePoints({
      ...(noiseCount != null ? { count: noiseCount } : {}),
      size: boxSize,
      material: { color: noiseColor, intensity: clamp01(intensity) },
      random,
    });

    // --- Parent group: the handle the Scene adds and the formations move ------
    /** The parent group added to the scene; move/scale this, not the children. @type {THREE.Group} */
    this.object3d = new THREE.Group();
    this.object3d.add(this.mesh);
    this.object3d.add(this.points);

    this.setScale(scale);
  }

  /**
   * The text plane material. Exposed so reveal-phase code can read/lerp
   * `material.color` and `material.opacity` directly.
   * @returns {THREE.MeshBasicMaterial}
   */
  get material() {
    return this.mesh.material;
  }

  /**
   * The parent group's scale vector (uniform). Lets callers read `mesh.scale.x`.
   * @returns {THREE.Vector3}
   */
  get scale() {
    return this.object3d.scale;
  }

  /**
   * The parent group's position vector.
   * @returns {THREE.Vector3}
   */
  get position() {
    return this.object3d.position;
  }

  /**
   * Current noise intensity in `[0, 1]` (0 = clear signal, 1 = fully noisy).
   * @returns {number}
   */
  get intensity() {
    return this.points.material.uniforms.uIntensity.value;
  }

  /**
   * Set the noise intensity, clamped to `[0, 1]`.
   * @param {number} v - Desired intensity.
   * @returns {this}
   */
  setIntensity(v) {
    setNoiseIntensity(this.points.material, v);
    return this;
  }

  /**
   * Set the text opacity, clamped to `[0, 1]`. Used to dim non-winning nicknames
   * during the reveal (Requirement 8.5) and to fade letters between formations.
   * @param {number} v - Desired opacity.
   * @returns {this}
   */
  setOpacity(v) {
    const clamped = clamp01(v);
    this.mesh.material.opacity = clamped;
    this.mesh.material.transparent = true;
    return this;
  }

  /**
   * Set the texture tint. The reveal sets this to cyan `#7df9ff` (Requirement 8.4).
   * @param {number|string|THREE.Color} hex - Any value THREE.Color accepts.
   * @returns {this}
   */
  setColor(hex) {
    this.mesh.material.color.set(hex);
    return this;
  }

  /**
   * Set the uniform scale of the whole element (text + noise cloud). The reveal
   * grows the winner to >= 3x its base size (Requirement 8.4).
   * @param {number} v - Uniform scale factor.
   * @returns {this}
   */
  setScale(v) {
    this.object3d.scale.setScalar(v);
    return this;
  }

  /**
   * Set the world-space position of the whole element.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {this}
   */
  setPosition(x, y, z) {
    this.object3d.position.set(x, y, z);
    return this;
  }

  /**
   * Advance the noise animation clock. Called each frame by the Scene render loop.
   * @param {number} dt - Seconds since the previous frame.
   */
  update(dt) {
    this.points.material.uniforms.uTime.value += dt;
  }

  /**
   * Orient the text toward a target (typically the camera) so it stays legible
   * from the audience while the sphere rotates (Requirement 7.1).
   * @param {THREE.Vector3|{x:number,y:number,z:number}} target
   * @returns {this}
   */
  lookAt(target) {
    this.object3d.lookAt(target.x, target.y, target.z);
    return this;
  }

  /** Release geometry, material, and texture GPU resources. */
  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this.texture && typeof this.texture.dispose === 'function') this.texture.dispose();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

/**
 * Render `text` onto a 2D canvas with the native font stack and wrap it in a
 * THREE.CanvasTexture. Returns the texture and its width/height aspect ratio so
 * the caller can size the display plane to avoid distortion.
 *
 * Falls back to a null texture (and aspect 4) when no usable canvas is available
 * (e.g. a non-DOM environment), so construction never throws.
 *
 * @param {string} text
 * @param {Document|null} doc
 * @returns {{ texture: ?THREE.CanvasTexture, aspect: number }}
 */
function renderTextTexture(text, doc) {
  if (!doc || typeof doc.createElement !== 'function') {
    return { texture: null, aspect: 4 };
  }

  let canvas;
  try {
    canvas = doc.createElement('canvas');
  } catch {
    return { texture: null, aspect: 4 };
  }
  const measureCtx = canvas.getContext && canvas.getContext('2d');
  if (!measureCtx) return { texture: null, aspect: 4 };

  const font = `700 ${CANVAS_FONT_PX}px ${FONT_STACK}`;
  measureCtx.font = font;
  const display = text && text.length > 0 ? text : ' ';
  const metrics = measureCtx.measureText(display);
  const textW = Math.max(1, Math.ceil(metrics.width));

  const w = textW + CANVAS_PADDING * 2;
  const h = CANVAS_FONT_PX + CANVAS_PADDING * 2;
  canvas.width = w;
  canvas.height = h;

  // Resizing the canvas resets the 2D context, so re-acquire and re-configure it.
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const cx = w / 2;
  const cy = h / 2;

  // Outer cyan glow baked into the texture (complements the scene bloom).
  ctx.shadowColor = 'rgba(125, 249, 255, 0.85)';
  ctx.shadowBlur = CANVAS_FONT_PX * 0.4;
  ctx.fillStyle = '#cdfaff';
  ctx.fillText(display, cx, cy);

  // Crisp white core on top for readability.
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(display, cx, cy);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  if ('colorSpace' in texture) {
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  texture.needsUpdate = true;

  return { texture, aspect: w / h };
}

/**
 * Back-compat no-op font loader. The Canvas-texture renderer uses the browser's
 * native fonts, so no typeface file is needed. Kept (and resolving immediately)
 * so existing callers that `await loadFont(url)` continue to work unchanged.
 *
 * @param {string} [url] - Ignored.
 * @returns {Promise<null>} Resolves immediately.
 */
export function loadFont(url) {
  return Promise.resolve(null);
}

/**
 * Clamp a number to the inclusive range `[0, 1]`. Non-finite inputs collapse to 0.
 * @param {number} v
 * @returns {number}
 */
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export default NicknameMesh;
