// Feature: after-party-lottery — Three.js scene wrapper for the 3D lottery animation.
//
// The Scene class owns the WebGLRenderer, perspective camera, lighting, and the
// requestAnimationFrame render loop bound to the page's #lottery-canvas. It also
// configures bloom post-processing so that cyan/purple emissive materials glow on
// the dark background, matching the "Signal Over Noise" visual identity
// (Requirement 7.4).
//
// `queueReveal(winner)` is a public hook that the WinnerReveal module (task 9.6)
// and the reveal queue in main.mjs (task 10.3) wire up by assigning `onReveal`.
// Until then it is a safe no-op.
//
// Three.js core is imported via the bare `three` specifier, which lottery.html
// maps through its <importmap> to a pinned unpkg build. The post-processing
// addons are not covered by that importmap, so they are imported from their full
// pinned unpkg URLs. Those addon files internally `import ... from 'three'`, which
// the importmap resolves to the same pinned build, keeping a single Three.js copy.

import * as THREE from 'three';
import { EffectComposer } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Dark scene background, consistent with lottery.html's --bg. */
const BACKGROUND_COLOR = 0x050914;
/** Cyan "signal" accent (matches lottery.html --signal). */
const SIGNAL_CYAN = 0x7df9ff;
/** Purple accent (matches lottery.html --signal-2). */
const ACCENT_PURPLE = 0xb98cff;

/**
 * Wraps the Three.js renderer, scene graph, camera, lighting, post-processing,
 * and animation loop for the lottery big-screen display.
 */
export class Scene {
  /**
   * @param {object} [options]
   * @param {HTMLCanvasElement} [options.canvas] - Target canvas. Defaults to the
   *   element with id `lottery-canvas`.
   * @param {boolean} [options.autoStart=true] - Start the render loop immediately.
   * @param {number} [options.bloomStrength=1.1] - UnrealBloomPass strength.
   * @param {number} [options.bloomRadius=0.6] - UnrealBloomPass radius.
   * @param {number} [options.bloomThreshold=0.12] - UnrealBloomPass luminance threshold.
   */
  constructor(options = {}) {
    const {
      canvas = (typeof document !== 'undefined'
        ? document.getElementById('lottery-canvas')
        : null),
      autoStart = true,
      bloomStrength = 0.55,
      bloomRadius = 0.5,
      bloomThreshold = 0.55,
    } = options;

    if (!canvas) {
      throw new Error('Scene requires a #lottery-canvas element or an explicit canvas option.');
    }

    this.canvas = canvas;

    /**
     * Assignable reveal hook. WinnerReveal / main.mjs sets this to a function
     * `(winner) => void`. Until wired it stays null and `queueReveal` is a no-op.
     * @type {?(winner: object) => void}
     */
    this.onReveal = null;

    // Objects with an `update(dt)` method registered via add() are ticked each frame.
    /** @type {Set<{ update: (dt: number) => void }>} */
    this._updatables = new Set();

    this._running = false;
    this._rafId = null;
    this._lastFrameMs = 0;
    this._animate = this._animate.bind(this);
    this._onResize = this._onResize.bind(this);

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initLights();
    this._initPostProcessing(bloomStrength, bloomRadius, bloomThreshold);

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._onResize);
    }

    if (autoStart) {
      this.start();
    }
  }

  /** Create the WebGL renderer with a dark clear color. */
  _initRenderer() {
    const { width, height } = this._canvasSize();
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(
      typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1,
    );
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(BACKGROUND_COLOR, 1);
    // Slightly punchy tone mapping so bloom on cyan/purple reads well on a projector.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
  }

  /** Create the scene graph with a dark background. */
  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND_COLOR);
  }

  /** Create the perspective camera positioned to view the sphere from the front. */
  _initCamera() {
    const { width, height } = this._canvasSize();
    const aspect = height === 0 ? 1 : width / height;
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 1000);
    this.camera.position.set(0, 0, 60);
    this.camera.lookAt(0, 0, 0);
  }

  /** Ambient fill plus cyan and purple point lights for the "Signal Over Noise" palette. */
  _initLights() {
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(this.ambientLight);

    this.cyanLight = new THREE.PointLight(SIGNAL_CYAN, 1.2, 0, 1.5);
    this.cyanLight.position.set(40, 30, 60);
    this.scene.add(this.cyanLight);

    this.purpleLight = new THREE.PointLight(ACCENT_PURPLE, 1.0, 0, 1.5);
    this.purpleLight.position.set(-45, -25, 40);
    this.scene.add(this.purpleLight);
  }

  /**
   * Configure the EffectComposer with a RenderPass and an UnrealBloomPass so that
   * emissive cyan/purple materials bloom against the dark background.
   */
  _initPostProcessing(strength, radius, threshold) {
    const { width, height } = this._canvasSize();
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(width, height);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      strength,
      radius,
      threshold,
    );
    this.composer.addPass(this.bloomPass);
  }

  /**
   * Add an object to the scene graph. If the object exposes an `update(dt)`
   * method it is also registered to be ticked by the render loop.
   * @param {THREE.Object3D & { update?: (dt: number) => void }} mesh
   * @returns {this}
   */
  add(mesh) {
    const object3d = mesh && mesh.isObject3D ? mesh : (mesh && mesh.object3d);
    this.scene.add(object3d || mesh);
    if (mesh && typeof mesh.update === 'function') {
      this._updatables.add(mesh);
    }
    return this;
  }

  /**
   * Remove an object from the scene graph and stop ticking it.
   * @param {THREE.Object3D & { update?: (dt: number) => void }} mesh
   * @returns {this}
   */
  remove(mesh) {
    const object3d = mesh && mesh.isObject3D ? mesh : (mesh && mesh.object3d);
    this.scene.remove(object3d || mesh);
    this._updatables.delete(mesh);
    return this;
  }

  /**
   * Advance per-frame state. Called automatically by the render loop with the
   * seconds elapsed since the previous frame. Ticks every registered updatable.
   * Override or extend in subclasses/wiring as needed.
   * @param {number} dt - Seconds since the previous frame.
   */
  update(dt) {
    for (const obj of this._updatables) {
      try {
        obj.update(dt);
      } catch (err) {
        // A single misbehaving mesh must not kill the whole render loop.
        // eslint-disable-next-line no-console
        console.error('[lottery] updatable threw during update():', err);
      }
    }
  }

  /**
   * Reveal-hook entry point. WinnerReveal (task 9.6) / main.mjs (task 10.3) assign
   * `this.onReveal` to receive winners. Until then this is a safe no-op stub.
   * @param {object} winner - The winning draw record `{ drawSeq, nickname, ... }`.
   */
  queueReveal(winner) {
    if (typeof this.onReveal === 'function') {
      this.onReveal(winner);
    }
  }

  /** Start the requestAnimationFrame render loop. Idempotent. */
  start() {
    if (this._running) return;
    this._running = true;
    this._lastFrameMs = this._nowMs();
    this._rafId = this._requestFrame(this._animate);
  }

  /** Stop the render loop. Idempotent. */
  stop() {
    this._running = false;
    if (this._rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this._rafId);
    }
    this._rafId = null;
  }

  /** The per-frame callback: compute dt, run update(dt), render through the composer. */
  _animate() {
    if (!this._running) return;
    const nowMs = this._nowMs();
    const dt = Math.max(0, (nowMs - this._lastFrameMs) / 1000);
    this._lastFrameMs = nowMs;

    this.update(dt);
    this.composer.render(dt);

    this._rafId = this._requestFrame(this._animate);
  }

  /** Update camera aspect and renderer/composer sizes when the window resizes. */
  _onResize() {
    const { width, height } = this._canvasSize();
    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    if (this.bloomPass && this.bloomPass.resolution) {
      this.bloomPass.resolution.set(width, height);
    }
  }

  /** Release GPU resources and detach listeners. */
  dispose() {
    this.stop();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onResize);
    }
    this._updatables.clear();
    if (this.composer && typeof this.composer.dispose === 'function') {
      this.composer.dispose();
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
  }

  /** Current viewport size from the canvas client box (fallback to a sane default). */
  _canvasSize() {
    const width = this.canvas.clientWidth || this.canvas.width || 1280;
    const height = this.canvas.clientHeight || this.canvas.height || 720;
    return { width, height };
  }

  /** High-resolution timestamp in milliseconds. */
  _nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  /** Schedule the next frame, falling back to setTimeout where rAF is unavailable. */
  _requestFrame(cb) {
    if (typeof requestAnimationFrame !== 'undefined') {
      return requestAnimationFrame(cb);
    }
    return setTimeout(() => cb(this._nowMs()), 16);
  }
}

export default Scene;
