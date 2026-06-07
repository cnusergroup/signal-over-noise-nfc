// Feature: after-party-lottery — particle "Signal Over Noise" show.
//
// A self-contained Three.js particle spectacle for the big-screen lottery:
//
//   1. Intro: a cloud of glowing particles flies in and morphs through the
//      letters  A → W → S → UG  (AWS User Group), one shape at a time.
//   2. Idle: the particles converge into a single 3D sphere that rotates
//      continuously around its vertical axis.
//   3. Reveal: when a winner is drawn, the sphere bursts/dims and the winner's
//      name (rendered to a Canvas texture, so Chinese / emoji / any Unicode work)
//      scales up at the center with a cyan glow, holds, then the sphere reforms.
//
// This module owns its own renderer, scene, camera, bloom composer, and render
// loop, so it is independent of the older name-mesh pipeline. It only needs a
// <canvas> to render into.
//
// Three.js core is imported via the bare `three` specifier (resolved by the
// page's <importmap>); the post-processing addons come from pinned unpkg URLs.

import * as THREE from 'three';
import { EffectComposer } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js';

const BG = 0x050914;
const CYAN = new THREE.Color(0x7df9ff);
const PURPLE = new THREE.Color(0xb98cff);

/** Phases of the show. */
export const Phase = Object.freeze({
  Intro: 'Intro',     // morphing through A/W/S/UG
  Sphere: 'Sphere',   // idle rotating sphere
  Reveal: 'Reveal',   // a winner name is held at center
});

/** The intro letter sequence. */
const LETTERS = ['A', 'W', 'S', 'UG'];

export class ParticleShow {
  /**
   * @param {object} [options]
   * @param {HTMLCanvasElement} [options.canvas] - Target canvas (defaults to #lottery-canvas).
   * @param {number} [options.count=6000] - Particle count.
   * @param {Document} [options.documentRef] - Document for offscreen text canvases.
   * @param {number} [options.letterHoldMs=2600] - How long each letter is held.
   * @param {number} [options.morphMs=1500] - Morph tween duration between shapes.
   * @param {() => void} [options.onIntroComplete] - Fired once when the A/W/S/UG
   *        letter sequence finishes and the show converges into the sphere.
   */
  constructor(options = {}) {
    const {
      canvas = (typeof document !== 'undefined' ? document.getElementById('lottery-canvas') : null),
      count = 6000,
      documentRef = (typeof document !== 'undefined' ? document : null),
      letterHoldMs = 2600,
      morphMs = 1500,
      onIntroComplete = null,
    } = options;

    if (!canvas) throw new Error('ParticleShow requires a canvas.');
    this.canvas = canvas;
    this.doc = documentRef;
    this.count = count;
    this.letterHoldMs = letterHoldMs;
    this.morphMs = morphMs;
    this.onIntroComplete = onIntroComplete;

    this.phase = Phase.Intro;
    this._t = 0;                 // global clock (s)
    this._morph = null;          // active morph tween
    this._rotation = 0;          // sphere spin angle
    this._reveal = null;         // active winner reveal state
    this._revealRotSpeed = null; // override rotation speed during reveal phases
    this._introIndex = 0;        // which letter we're on
    this._introTimer = 0;        // ms elapsed in current letter hold
    this._introMorphing = true;  // morphing vs holding

    this._initRenderer();
    this._initScene();
    this._initParticles();
    this._initComposer();

    // Precompute shape targets.
    this._sphereTargets = this._makeSphere();
    this._letterTargets = LETTERS.map((ch) => this._makeLetter(ch));

    // Start scattered, then morph into the first letter.
    this._scatter();
    this._startMorph(this._letterTargets[0]);

    this._animate = this._animate.bind(this);
    this._onResize = this._onResize.bind(this);
    if (typeof window !== 'undefined') window.addEventListener('resize', this._onResize);
    this._running = true;
    this._lastMs = this._nowMs();
    this._raf = requestAnimationFrame(this._animate);
  }

  _initRenderer() {
    const { w, h } = this._size();
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(BG, 1);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG);
    const { w, h } = this._size();
    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 2000);
    this.camera.position.set(0, 0, 46);
    this.camera.lookAt(0, 0, 0);
  }

  _initParticles() {
    const n = this.count;
    this.positions = new Float32Array(n * 3);   // current
    this.targets = new Float32Array(n * 3);      // morph target
    this.starts = new Float32Array(n * 3);       // morph start snapshot
    const colors = new Float32Array(n * 3);

    // Color gradient cyan→purple across particles.
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      c.copy(CYAN).lerp(PURPLE, Math.random() * 0.85);
      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry = geo;

    const sprite = this._makeDotTexture();
    this.material = new THREE.PointsMaterial({
      size: 0.42,
      map: sprite,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.95,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.group = new THREE.Group();
    this.group.add(this.points);
    this.scene.add(this.group);
  }

  _initComposer() {
    const { w, h } = this._size();
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(w, h);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.7, 0.2);
    this.composer.addPass(this.bloom);
  }

  // ---- shape generators ----------------------------------------------------

  /** Fibonacci sphere targets scaled to a display radius. */
  _makeSphere() {
    const n = this.count;
    const out = new Float32Array(n * 3);
    const radius = 15;
    const phi = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = phi * i;
      out[i * 3 + 0] = Math.cos(theta) * r * radius;
      out[i * 3 + 1] = y * radius;
      out[i * 3 + 2] = Math.sin(theta) * r * radius;
    }
    return out;
  }

  /**
   * Rasterize `ch` (a single letter "A", a short combo "UG", or a longer phrase
   * like "Community Day") to a bitmap, collect filled pixels, and map them to
   * centered world coords with real 3D thickness so the particle word reads as
   * a sculpted volume rather than a flat plane.
   *
   * Volume strategy: every particle is placed at a sampled glyph (x, y) and
   * given a random `z` along the depth axis, plus a small in-plane jitter
   * proportional to the local thickness. The result is a "3D extruded" word
   * shape made of glowing dots — same particle technology as the lottery
   * sphere, but molded into the letter form (no rotation, per spec).
   * @param {string} ch
   * @returns {Float32Array}
   */
  _makeLetter(ch) {
    const n = this.count;
    const out = new Float32Array(n * 3);

    // Wider canvas for longer phrases so glyphs aren't clipped or warped.
    // Width grows with character count; height stays fixed for a uniform glyph
    // height across all intro frames.
    const len = (ch || '').length;
    const GW = Math.min(720, Math.max(120, Math.round(len * 56 + 60)));
    const GH = 120;
    const pts = this._sampleGlyph(ch, GW, GH);

    // World span scales with the canvas aspect so longer phrases stay readable
    // without growing taller than the single letters. Cap the on-screen width so
    // multi-word phrases like "Community Day" don't run off the canvas edges.
    const worldH = 26;
    const aspect = GW / GH;
    const worldW = Math.min(worldH * aspect, 64); // cap world width
    // Depth (z) extent: pure flat plane (0 depth). The name is viewed straight-on
    // from the camera, so any z spread only makes it harder to read. Zero depth
    // keeps every particle in a single plane for maximum legibility.
    const worldDepth = 0;

    if (pts.length === 0) {
      // Fallback: ring with depth.
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        out[i * 3 + 0] = Math.cos(a) * 10;
        out[i * 3 + 1] = Math.sin(a) * 10;
        out[i * 3 + 2] = (Math.random() - 0.5) * worldDepth;
      }
      return out;
    }

    // Convert pixel-space jitter to world-space units once.
    const sxx = worldW / (GW - 1);
    const syy = worldH / (GH - 1);

    for (let i = 0; i < n; i++) {
      const p = pts[i % pts.length];

      // In-plane jitter: moderate for all particles, larger for "overflow" ones
      // (beyond the pixel set) to fill out the letter volume smoothly and avoid
      // visible vertical/horizontal stripe artifacts from pixel-grid repetition.
      const overflow = i >= pts.length;
      const jitterPx = overflow ? (Math.random() - 0.5) * 3.0 : (Math.random() - 0.5) * 1.2;
      const jitterPy = overflow ? (Math.random() - 0.5) * 3.0 : (Math.random() - 0.5) * 1.2;

      const x = (p[0] / (GW - 1) - 0.5) * worldW + jitterPx * sxx;
      const y = (0.5 - p[1] / (GH - 1)) * worldH + jitterPy * syy;

      // Z = 0 (flat plane); no depth variation.
      const z = 0;

      out[i * 3 + 0] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }
    return out;
  }

  /** Sample filled glyph pixels from an offscreen canvas. */
  _sampleGlyph(ch, GW, GH) {
    const doc = this.doc;
    if (!doc || !doc.createElement) return [];
    const cv = doc.createElement('canvas');
    cv.width = GW; cv.height = GH;
    const ctx = cv.getContext('2d');
    if (!ctx) return [];
    ctx.clearRect(0, 0, GW, GH);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Choose a font size that fits the phrase within ~92% of the canvas width
    // while never exceeding the canvas height. Single letters render large;
    // multi-word phrases automatically shrink to fit.
    const base = `900 "Arial Black", Arial, sans-serif`;
    let size = Math.floor(GH * 0.96);
    ctx.font = `900 ${size}px "Arial Black", "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
    let metrics = ctx.measureText(ch);
    const maxW = GW * 0.92;
    if (metrics.width > maxW) {
      size = Math.max(18, Math.floor(size * (maxW / metrics.width)));
      ctx.font = `900 ${size}px "Arial Black", "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
    }
    ctx.fillText(ch, GW / 2, GH / 2 + GH * 0.04);

    let data;
    try { data = ctx.getImageData(0, 0, GW, GH).data; } catch { return []; }
    const pts = [];
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        if (data[(y * GW + x) * 4 + 3] > 128) pts.push([x, y]);
      }
    }
    // Shuffle so particle assignment is even.
    for (let i = pts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pts[i]; pts[i] = pts[j]; pts[j] = t;
    }
    return pts;
  }

  /** Soft round dot sprite for particles. */
  _makeDotTexture() {
    const doc = this.doc;
    if (!doc || !doc.createElement) return null;
    const s = 64;
    const cv = doc.createElement('canvas');
    cv.width = s; cv.height = s;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  // ---- particle motion -----------------------------------------------------

  _scatter() {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const r = 40 + Math.random() * 40;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      this.positions[i * 3 + 0] = r * Math.sin(ph) * Math.cos(th);
      this.positions[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      this.positions[i * 3 + 2] = r * Math.cos(ph);
    }
  }

  _startMorph(targetArr, durationMs) {
    this.starts.set(this.positions);
    this.targets.set(targetArr);
    this._morph = { elapsed: 0, duration: (durationMs ?? this.morphMs) / 1000 };
  }

  // ---- public API ----------------------------------------------------------

  /**
   * Queue a winner reveal. The name is rendered to a canvas texture and shown at
   * the center. `nickname` may be any Unicode (Chinese supported).
   * @param {string} nickname
   */
  showWinner(nickname) {
    this._pendingWinner = String(nickname == null ? '' : nickname);
  }

  /** Current phase name. */
  getPhase() { return this.phase; }

  // ---- loop ----------------------------------------------------------------

  _animate() {
    if (!this._running) return;
    const ms = this._nowMs();
    const dt = Math.min(0.05, Math.max(0, (ms - this._lastMs) / 1000));
    this._lastMs = ms;
    this._t += dt;

    this._updateMorph(dt);
    this._updatePhase(dt);
    this._updateRotation(dt);
    this._updateReveal(dt);

    this.geometry.attributes.position.needsUpdate = true;
    this.composer.render(dt);
    this._raf = requestAnimationFrame(this._animate);
  }

  _updateMorph(dt) {
    const m = this._morph;
    if (!m) return;
    m.elapsed += dt;
    const t = m.duration <= 0 ? 1 : Math.min(1, m.elapsed / m.duration);
    const e = t * t * (3 - 2 * t); // smoothstep
    const n = this.count;
    for (let i = 0; i < n * 3; i++) {
      this.positions[i] = this.starts[i] + (this.targets[i] - this.starts[i]) * e;
    }
    if (t >= 1) this._morph = null;
  }

  _updatePhase(dt) {
    if (this.phase === Phase.Intro) {
      if (this._morph) return; // wait for current morph
      // Holding the current letter.
      this._introTimer += dt * 1000;
      if (this._introTimer >= this.letterHoldMs) {
        this._introTimer = 0;
        this._introIndex += 1;
        if (this._introIndex < this._letterTargets.length) {
          this._startMorph(this._letterTargets[this._introIndex]);
        } else {
          // Done with letters → converge into the sphere.
          this.phase = Phase.Sphere;
          this._startMorph(this._sphereTargets, 2200);
          if (typeof this.onIntroComplete === 'function') {
            try { this.onIntroComplete(); } catch (e) { /* no-op */ }
          }
        }
      }
    }
  }

  _updateRotation(dt) {
    // 字幕阶段完全不旋转，定格展示。
    if (this.phase === Phase.Intro) {
      this.group.rotation.y = 0;
      return;
    }
    // During a reveal, rotation speed is overridden per-phase.
    const speed = this._revealRotSpeed != null ? this._revealRotSpeed : 0.18;
    this._rotation += speed * dt;
    this.group.rotation.y = this._rotation;
  }

  _updateReveal(dt) {
    // Start a queued reveal once we're in the sphere/idle and not already revealing.
    if (this._pendingWinner != null && !this._reveal && this.phase !== Phase.Intro) {
      this._beginReveal(this._pendingWinner);
      this._pendingWinner = null;
    }
    const r = this._reveal;
    if (!r) return;
    r.elapsed += dt;

    // Phase timings (seconds):
    const burstDur = 1.2;   // noise burst — particles explode outward
    const formDur = 2.0;    // signal forming — particles converge to name shape
    const holdDur = 5.0;    // hold — name stable, glowing
    const dissolveDur = 1.8; // dissolve — particles return to sphere
    const total = burstDur + formDur + holdDur + dissolveDur;

    const n = this.count;
    const colors = this.geometry.attributes.color;

    if (r.elapsed <= burstDur) {
      // PHASE 1: Noise burst — particles scatter outward from sphere with jitter.
      // Morph is already running (set in _beginReveal to exploded positions).
      // Increase bloom, speed rotation, lower opacity slightly for chaos feel.
      const t = r.elapsed / burstDur;
      this.bloom.strength = 0.9 + 1.2 * t;
      this._revealRotSpeed = 0.18 + 0.8 * t; // temporarily stored for rotation
      this.material.opacity = 0.95 - 0.2 * t;

    } else if (r.elapsed <= burstDur + formDur) {
      // PHASE 2: Signal forms — particles morph from exploded positions to name shape.
      const localT = r.elapsed - burstDur;
      if (!r.formStarted) {
        r.formStarted = true;
        this._startMorph(r.nameTargets, formDur * 1000);
        this._revealRotSpeed = 0;
      }
      const t = localT / formDur;
      this.bloom.strength = 2.1 - 1.5 * t;
      this.material.opacity = 0.75 + 0.2 * t;
      // Color shift toward white.
      for (let i = 0; i < n; i++) {
        const lerpAmt = t * 0.5;
        colors.array[i * 3 + 0] = colors.array[i * 3 + 0] * (1 - lerpAmt) + 1.0 * lerpAmt;
        colors.array[i * 3 + 1] = colors.array[i * 3 + 1] * (1 - lerpAmt) + 1.0 * lerpAmt;
        colors.array[i * 3 + 2] = colors.array[i * 3 + 2] * (1 - lerpAmt) + 1.0 * lerpAmt;
      }
      colors.needsUpdate = true;
      // Text label fades in during the second half of the form phase.
      if (r.labelSprite) {
        const labelT = Math.max(0, (t - 0.4) / 0.6); // starts at 40% of form
        r.labelSprite.material.opacity = labelT * 0.85;
      }

    } else if (r.elapsed <= burstDur + formDur + holdDur) {
      // PHASE 3: Hold — name shape stable, text label fully visible.
      this._revealRotSpeed = 0;
      this.bloom.strength = 0.6;
      this.material.opacity = 0.95;
      const breathT = (r.elapsed - burstDur - formDur);
      const breath = 1 + Math.sin(breathT * 1.8) * 0.015;
      this.group.scale.setScalar(breath);
      if (r.labelSprite) r.labelSprite.material.opacity = 0.85;

    } else if (r.elapsed <= total) {
      // PHASE 4: Dissolve — particles morph back to the sphere, label fades out.
      const localT = r.elapsed - burstDur - formDur - holdDur;
      if (!r.dissolveStarted) {
        r.dissolveStarted = true;
        this._startMorph(this._sphereTargets, dissolveDur * 1000);
        this._revealRotSpeed = 0.05;
      }
      const t = localT / dissolveDur;
      this.bloom.strength = 0.6 + 0.3 * t;
      this._revealRotSpeed = 0.05 + 0.13 * t;
      this.group.scale.setScalar(1);
      // Label fades out.
      if (r.labelSprite) r.labelSprite.material.opacity = 0.85 * (1 - t);
      // Restore original cyan/purple colors.
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        c.copy(CYAN).lerp(PURPLE, (i / n) * 0.85);
        const restore = t;
        colors.array[i * 3 + 0] = colors.array[i * 3 + 0] * (1 - restore) + c.r * restore;
        colors.array[i * 3 + 1] = colors.array[i * 3 + 1] * (1 - restore) + c.g * restore;
        colors.array[i * 3 + 2] = colors.array[i * 3 + 2] * (1 - restore) + c.b * restore;
      }
      colors.needsUpdate = true;

    } else {
      // Done — clean up label sprite and restore sphere.
      if (r.labelSprite) {
        this.scene.remove(r.labelSprite);
        if (r.labelSprite.material.map) r.labelSprite.material.map.dispose();
        r.labelSprite.material.dispose();
      }
      this.group.scale.setScalar(1);
      this.bloom.strength = 0.9;
      this.material.opacity = 0.95;
      this._revealRotSpeed = null;
      this._reveal = null;
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        c.copy(CYAN).lerp(PURPLE, (i / n) * 0.85);
        colors.array[i * 3 + 0] = c.r;
        colors.array[i * 3 + 1] = c.g;
        colors.array[i * 3 + 2] = c.b;
      }
      colors.needsUpdate = true;
    }
  }

  _beginReveal(nickname) {
    // Reset group rotation so the name faces the camera head-on (z=0 plane).
    // Without this, the group retains the sphere-spin angle and the flat name
    // shape appears rotated/sideways ("vertical"), making it unreadable.
    this.group.rotation.y = 0;
    this._rotation = 0;

    // Generate target positions for the winner's name using the same glyph-to-particle
    // system as the intro letters. Chinese/emoji all supported via canvas rasterization.
    const nameTargets = this._makeLetter(nickname);

    // Create a clean text overlay sprite that ensures the name is always readable
    // even when particles alone are too sparse for complex CJK characters.
    const labelSprite = this._makeLabelSprite(nickname);
    if (labelSprite) {
      labelSprite.material.opacity = 0;
      labelSprite.position.set(0, 0, 2); // slightly in front of particle plane
      labelSprite.renderOrder = 999;
      this.scene.add(labelSprite);
    }

    // Start by exploding particles outward (noise burst).
    const n = this.count;
    const exploded = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = this.positions[i * 3 + 0];
      const y = this.positions[i * 3 + 1];
      const z = this.positions[i * 3 + 2];
      const push = 1.4 + Math.random() * 1.2;
      exploded[i * 3 + 0] = x * push + (Math.random() - 0.5) * 8;
      exploded[i * 3 + 1] = y * push + (Math.random() - 0.5) * 8;
      exploded[i * 3 + 2] = z * push + (Math.random() - 0.5) * 8;
    }
    this._startMorph(exploded, 1200);

    this._reveal = {
      elapsed: 0,
      nameTargets,
      formStarted: false,
      dissolveStarted: false,
      labelSprite,
    };
  }

  /**
   * Create a Sprite with the winner's name rendered clearly (white text, very
   * subtle glow) so it overlays the particle formation and guarantees readability.
   * @param {string} text
   * @returns {?THREE.Sprite}
   */
  _makeLabelSprite(text) {
    const doc = this.doc;
    if (!doc || !doc.createElement) return null;
    const display = text && text.length ? text : ' ';
    const cv = doc.createElement('canvas');
    const mctx = cv.getContext('2d');
    if (!mctx) return null;
    const FS = 128;
    const font = `700 ${FS}px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Inter",system-ui,sans-serif`;
    mctx.font = font;
    const tw = Math.ceil(mctx.measureText(display).width);
    const pad = 40;
    cv.width = tw + pad * 2;
    cv.height = FS + pad * 2;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = cv.width / 2, cy = cv.height / 2;
    // Subtle outer glow.
    ctx.shadowColor = 'rgba(125,249,255,0.5)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(display, cx, cy);
    // Crisp white core.
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(display, cx, cy);

    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0,
      depthWrite: false, depthTest: false,
      blending: THREE.NormalBlending, toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    const aspect = cv.width / cv.height;
    const h = 5.5; // world height
    sprite.scale.set(h * aspect, h, 1);
    return sprite;
  }

  // ---- plumbing ------------------------------------------------------------

  _size() {
    const w = this.canvas.clientWidth || this.canvas.width || 1280;
    const h = this.canvas.clientHeight || this.canvas.height || 720;
    return { w, h };
  }

  _onResize() {
    const { w, h } = this._size();
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    if (this.bloom.resolution) this.bloom.resolution.set(w, h);
  }

  _nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  dispose() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (typeof window !== 'undefined') window.removeEventListener('resize', this._onResize);
    this.geometry.dispose();
    this.material.dispose();
    this.composer.dispose && this.composer.dispose();
    this.renderer.dispose();
  }
}

export default ParticleShow;
