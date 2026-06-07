// Feature: after-party-lottery — particle "orb" intro animation.
//
// A pool of glowing spherical particles morphs through a sequence of glyph
// targets (default: A → W → S → UG → 3), then loops. Each target shape is sampled
// from a canvas-rendered glyph into a point cloud; the same fixed particle pool is
// re-targeted and tweened between shapes, so the orbs appear to flow from one
// letter into the next.
//
// Rendered as a single THREE.Points cloud (cheap for thousands of particles) with
// a soft radial sprite + additive blending, so under the Scene's bloom each point
// reads as a glowing cyan/purple orb. Exposes `.object3d` (the Points) and
// `update(dt)`, matching the Scene's render-loop convention (Scene.add ticks any
// added object exposing update(dt)).

import * as THREE from 'three';

/** Cyan signal accent. */
const CYAN = [0x7d / 255, 0xf9 / 255, 0xff / 255];
/** Purple accent. */
const PURPLE = [0xb9 / 255, 0x8c / 255, 0xff / 255];

/** World-space height each glyph spans. */
const GLYPH_HEIGHT = 22;
/** Offscreen sampling canvas height in px (higher = finer sampling). */
const SAMPLE_H = 180;

const FONT_STACK =
  '"Arial Black", "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

/**
 * A morphing particle-orb intro animation.
 */
export class IntroParticles {
  /**
   * @param {object} [options]
   * @param {string[]} [options.sequence] - Glyph targets to morph through, in order.
   * @param {number} [options.count=4500] - Particle pool size.
   * @param {number} [options.morphDuration=1.5] - Seconds to morph between glyphs.
   * @param {number} [options.holdDuration=1.4] - Seconds to hold each formed glyph.
   * @param {number} [options.pointSize=0.42] - World-space particle size.
   * @param {boolean} [options.loop=true] - Loop back to the first glyph after the last.
   * @param {Document} [options.documentRef] - Document used for the sampling canvas.
   * @param {() => number} [options.random=Math.random] - Injectable RNG.
   */
  constructor(options = {}) {
    const {
      sequence = ['A', 'W', 'S', 'UG', '3'],
      count = 4500,
      morphDuration = 1.5,
      holdDuration = 1.4,
      pointSize = 0.42,
      loop = true,
      documentRef = (typeof document !== 'undefined' ? document : null),
      random = Math.random,
    } = options;

    this.count = count;
    this.morphDuration = morphDuration;
    this.holdDuration = holdDuration;
    this.loop = loop;
    this.random = random;
    this.doc = documentRef;

    // Precompute a target position buffer (Float32Array length count*3) per glyph.
    this.targets = sequence.map((g) => this._buildTarget(g));

    // Tween buffers.
    this.from = new Float32Array(count * 3);
    this.to = new Float32Array(count * 3);
    this.base = new Float32Array(count * 3);

    // Per-particle drift seeds (so the cloud breathes while holding a glyph).
    this.seed = new Float32Array(count);
    for (let i = 0; i < count; i++) this.seed[i] = random() * Math.PI * 2;

    // Entrance: start from a random sphere cloud and morph into the first glyph.
    this._fillRandomCloud(this.from, 34);
    this.to.set(this.targets[0]);
    this.base.set(this.from);

    this.phaseIndex = 0;       // index of the glyph we are morphing TO
    this.phase = 'morph';      // 'morph' | 'hold'
    this.phaseElapsed = 0;
    this.time = 0;
    this.finished = false;

    this._buildPoints(pointSize);
  }

  /** Build the THREE.Points cloud with per-particle colors and a soft sprite. */
  _buildPoints(pointSize) {
    const positions = new Float32Array(this.base); // initial = entrance cloud
    const colors = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const t = this.random();
      const r = CYAN[0] + (PURPLE[0] - CYAN[0]) * t;
      const g = CYAN[1] + (PURPLE[1] - CYAN[1]) * t;
      const b = CYAN[2] + (PURPLE[2] - CYAN[2]) * t;
      colors[i * 3 + 0] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: pointSize,
      map: this._makeSprite(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      opacity: 0.95,
      toneMapped: false,
    });

    /** The Points cloud added to the scene. @type {THREE.Points} */
    this.points = new THREE.Points(geometry, material);
    /** Handle the Scene adds to the graph. @type {THREE.Points} */
    this.object3d = this.points;
    this._positionAttr = geometry.getAttribute('position');
  }

  /** Generate a soft radial-gradient sprite so each point reads as a glowing orb. */
  _makeSprite() {
    const doc = this.doc;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const c = doc.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.55, 'rgba(180,230,255,0.35)');
    grad.addColorStop(1.0, 'rgba(180,230,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  /** Fill a buffer with a random spherical cloud of the given radius. */
  _fillRandomCloud(buf, radius) {
    for (let i = 0; i < this.count; i++) {
      // Uniform-ish point in a ball.
      const u = this.random();
      const r = radius * Math.cbrt(u);
      const theta = this.random() * Math.PI * 2;
      const phi = Math.acos(2 * this.random() - 1);
      buf[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      buf[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      buf[i * 3 + 2] = r * Math.cos(phi) * 0.4; // flatten z a touch
    }
  }

  /**
   * Sample a glyph string into `count` target positions (Float32Array len count*3).
   * Renders the glyph to a canvas, collects filled pixels, and scatters the
   * particle pool across them (cycling with jitter when there are more particles
   * than filled pixels).
   * @param {string} text
   * @returns {Float32Array}
   */
  _buildTarget(text) {
    const out = new Float32Array(this.count * 3);
    const filled = this._sampleGlyph(text);

    if (filled.length === 0) {
      this._fillRandomCloud(out, 14);
      return out;
    }

    for (let i = 0; i < this.count; i++) {
      const p = filled[Math.floor(this.random() * filled.length)];
      // Sub-pixel jitter so multiple particles on one pixel spread out.
      const jx = (this.random() - 0.5) * 0.5;
      const jy = (this.random() - 0.5) * 0.5;
      out[i * 3 + 0] = p[0] + jx;
      out[i * 3 + 1] = p[1] + jy;
      out[i * 3 + 2] = (this.random() - 0.5) * 2.2; // shallow depth
    }
    return out;
  }

  /**
   * Render `text` and return its filled-pixel coordinates mapped to centered world
   * space (array of [x, y]).
   * @param {string} text
   * @returns {Array<[number, number]>}
   */
  _sampleGlyph(text) {
    const doc = this.doc;
    if (!doc || typeof doc.createElement !== 'function') return [];

    const canvas = doc.createElement('canvas');
    const measureCtx = canvas.getContext && canvas.getContext('2d');
    if (!measureCtx) return [];

    const fontPx = Math.floor(SAMPLE_H * 0.82);
    const font = `900 ${fontPx}px ${FONT_STACK}`;
    measureCtx.font = font;
    const w = Math.max(1, Math.ceil(measureCtx.measureText(text).width)) + 40;
    const h = SAMPLE_H;
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);

    const data = ctx.getImageData(0, 0, w, h).data;
    const scale = GLYPH_HEIGHT / h;
    const worldW = w * scale;
    const worldH = h * scale;
    const pts = [];
    // Step 2px for a good density without exploding the candidate list.
    for (let py = 0; py < h; py += 2) {
      for (let px = 0; px < w; px += 2) {
        if (data[(py * w + px) * 4 + 3] > 128) {
          const x = (px / w - 0.5) * worldW;
          const y = (0.5 - py / h) * worldH;
          pts.push([x, y]);
        }
      }
    }
    return pts;
  }

  /** Whether the (non-looping) sequence has finished its last hold. */
  isFinished() {
    return this.finished;
  }

  /**
   * Advance the morph/hold state machine and write particle positions.
   * @param {number} dt - Seconds since the previous frame.
   */
  update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 0;
    this.time += step;
    this.phaseElapsed += step;

    if (this.phase === 'morph') {
      const t = this.morphDuration <= 0 ? 1 : Math.min(this.phaseElapsed / this.morphDuration, 1);
      const e = easeInOutCubic(t);
      for (let i = 0; i < this.base.length; i++) {
        this.base[i] = this.from[i] + (this.to[i] - this.from[i]) * e;
      }
      if (t >= 1) {
        this.phase = 'hold';
        this.phaseElapsed = 0;
      }
    } else {
      // Hold: base stays at the formed glyph.
      if (this.phaseElapsed >= this.holdDuration) {
        const next = this.phaseIndex + 1;
        if (next >= this.targets.length) {
          if (this.loop) {
            this._advanceTo(0);
          } else {
            this.finished = true;
          }
        } else {
          this._advanceTo(next);
        }
      }
    }

    // Write displayed positions = base + gentle breathing drift.
    const pos = this._positionAttr.array;
    const tt = this.time;
    for (let i = 0; i < this.count; i++) {
      const s = this.seed[i];
      const k = i * 3;
      pos[k + 0] = this.base[k + 0] + Math.sin(tt * 0.9 + s) * 0.14;
      pos[k + 1] = this.base[k + 1] + Math.cos(tt * 1.1 + s) * 0.14;
      pos[k + 2] = this.base[k + 2] + Math.sin(tt * 0.7 + s * 1.7) * 0.5;
    }
    this._positionAttr.needsUpdate = true;

    // Slow, subtle Y rotation for life.
    this.points.rotation.y = Math.sin(this.time * 0.15) * 0.18;
  }

  /** Snapshot current base as `from`, set `to` = glyph[index], begin morphing. */
  _advanceTo(index) {
    this.phaseIndex = index;
    this.from.set(this.base);
    this.to.set(this.targets[index]);
    this.phase = 'morph';
    this.phaseElapsed = 0;
  }

  /** Release GPU resources. */
  dispose() {
    this.points.geometry.dispose();
    if (this.points.material.map) this.points.material.map.dispose();
    this.points.material.dispose();
  }
}

/** Smooth ease-in-out cubic on [0,1]. */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export default IntroParticles;
