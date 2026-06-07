// Feature: after-party-lottery — converge nickname meshes into a rotating sphere.
//
// The SphereFormation arranges a list of NicknameMesh instances onto the surface
// of a sphere using the Fibonacci-lattice points from sphere.mjs, tweening each
// mesh from its current position to its sphere target over 2–4 seconds. After the
// convergence completes, the whole sphere rotates continuously around its
// vertical (Y) axis at 10°/s — inside the 5–15°/s band required by the spec
// (Requirement 7.1, 7.3). Every frame each nickname is oriented toward the camera
// with `lookAt` so the text stays legible to the audience even as the sphere
// turns.
//
// Wiring convention (mirrors scene.mjs):
//   - All meshes are reparented under a single parent THREE.Group that this class
//     owns and exposes as `.object3d`. The Scene's `add()` adds that group to the
//     scene graph and registers this formation's `update(dt)` in its render-loop
//     tick set (because this class exposes an `update(dt)` method).
//   - This class does NOT advance the per-mesh noise clock. Each NicknameMesh's
//     own `update(dt)` (the noise `uTime` tick) is driven by the Scene when the
//     mesh is registered there, exactly as during the letter-formation phase.
//     Reparenting a mesh's `object3d` under this group does not remove the mesh
//     wrapper from the Scene's updatable set, so the noise animation keeps
//     running without being double-ticked here.
//
// Three.js core is imported via the bare `three` specifier resolved by
// lottery.html's <importmap>, matching scene.mjs and nickname-mesh.mjs.

import * as THREE from 'three';

import { fibonacciSphere, sphereRadius } from './sphere.mjs';

/** Default convergence duration (seconds). Sits in the 2–4 s band of Requirement 7.1. */
export const DEFAULT_FORM_DURATION_S = 3;

/** Default sphere spin rate in degrees per second (within the 5–15°/s band). */
export const DEFAULT_ROTATION_DEG_PER_SEC = 10;

/**
 * Arranges NicknameMesh instances onto a sphere and spins the sphere about Y.
 */
export class SphereFormation {
  /**
   * @param {Array<import('./nickname-mesh.mjs').NicknameMesh>} meshes - The
   *   nickname meshes to arrange. Each must expose `.object3d` (a THREE.Object3D),
   *   `setPosition(x, y, z)`, and `lookAt(target)`.
   * @param {THREE.Camera|{x:number,y:number,z:number}|(() => (THREE.Camera|{x:number,y:number,z:number}))} camera
   *   The camera (or a {x,y,z} point, or a function returning either) that each
   *   nickname should face so the text stays legible.
   * @param {object} [options]
   * @param {number} [options.durationS=3] - Convergence tween duration in seconds
   *   (intended range 2–4 s per Requirement 7.1).
   * @param {number} [options.rotationDegPerSec=10] - Y-axis spin rate in deg/s
   *   (intended range 5–15°/s per Requirement 7.1/7.3).
   * @param {number} [options.radius] - Explicit sphere radius. Defaults to
   *   `sphereRadius(meshes.length)` (Requirement 7.5 density rule).
   * @param {boolean} [options.rotateDuringForming=false] - When false (default),
   *   the sphere only begins rotating after the convergence tween completes, as
   *   Requirement 7.1 specifies ("...over a duration of 2 to 4 seconds, after
   *   which the sphere SHALL continuously rotate...").
   */
  constructor(meshes, camera, options = {}) {
    const {
      durationS = DEFAULT_FORM_DURATION_S,
      rotationDegPerSec = DEFAULT_ROTATION_DEG_PER_SEC,
      radius,
      rotateDuringForming = false,
    } = options;

    /** @type {Array<import('./nickname-mesh.mjs').NicknameMesh>} */
    this.meshes = Array.isArray(meshes) ? meshes.slice() : [];

    /** The camera/point/function the nicknames orient toward. */
    this.cameraTarget = camera;

    /** Convergence duration in seconds (never negative). @type {number} */
    this.durationS = Math.max(0, durationS);

    /** Spin rate in radians per second. @type {number} */
    this.rotationSpeedRad = (rotationDegPerSec * Math.PI) / 180;

    /** Whether to spin while still converging. @type {boolean} */
    this.rotateDuringForming = Boolean(rotateDuringForming);

    /** Sphere radius in world units. @type {number} */
    this.radius = typeof radius === 'number' ? radius : sphereRadius(this.meshes.length);

    /** Parent group that holds every nickname and spins about Y. @type {THREE.Group} */
    this.group = new THREE.Group();

    /** Seconds elapsed since the convergence tween began. @type {number} */
    this._elapsed = 0;

    /** True once the convergence tween reaches its target. @type {boolean} */
    this.complete = this.meshes.length === 0;

    // Scratch vector reused each frame for the camera position (no per-frame alloc).
    this._cameraPos = new THREE.Vector3();

    // Compute targets, capture start positions, and reparent under the group.
    this._items = this._buildItems();
  }

  /**
   * The handle the Scene adds to the scene graph (Scene.add reads `.object3d`).
   * @returns {THREE.Group}
   */
  get object3d() {
    return this.group;
  }

  /**
   * Compute sphere targets, snapshot each mesh's current world position as the
   * tween start, and reparent the mesh under the (identity-transform) group so
   * its current local position equals its world position at t = 0.
   * @returns {Array<{ mesh: object, start: THREE.Vector3, target: THREE.Vector3 }>}
   */
  _buildItems() {
    const n = this.meshes.length;
    const unitPoints = fibonacciSphere(n);
    const items = [];

    for (let i = 0; i < n; i++) {
      const mesh = this.meshes[i];
      const object3d = mesh.object3d;

      // Snapshot the current WORLD position before reparenting. Because the group
      // starts at the identity transform, this world position is also the correct
      // group-local start, giving a seamless hand-off from the previous formation.
      const start = new THREE.Vector3();
      if (object3d && typeof object3d.getWorldPosition === 'function') {
        object3d.getWorldPosition(start);
      } else if (object3d && object3d.position) {
        start.copy(object3d.position);
      }

      const [ux, uy, uz] = unitPoints[i];
      const target = new THREE.Vector3(ux * this.radius, uy * this.radius, uz * this.radius);

      // Reparent under the spinning group (THREE removes it from any old parent),
      // then pin its local position to the captured start so nothing jumps.
      if (object3d) {
        this.group.add(object3d);
        object3d.position.copy(start);
      }

      items.push({ mesh, start, target });
    }

    return items;
  }

  /**
   * Advance the convergence tween, spin the sphere, and re-orient every nickname
   * toward the camera. Called once per frame by the Scene render loop.
   * @param {number} dt - Seconds since the previous frame.
   */
  update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    // --- Convergence tween (ease-in-out via smoothstep) ----------------------
    if (!this.complete) {
      this._elapsed += step;
      const t = this.durationS <= 0 ? 1 : Math.min(this._elapsed / this.durationS, 1);
      const e = smoothstep(t);
      for (const item of this._items) {
        const x = item.start.x + (item.target.x - item.start.x) * e;
        const y = item.start.y + (item.target.y - item.start.y) * e;
        const z = item.start.z + (item.target.z - item.start.z) * e;
        item.mesh.setPosition(x, y, z);
      }
      if (t >= 1) this.complete = true;
    }

    // --- Spin about the Y axis (after forming, per Requirement 7.1) ----------
    if (this.complete || this.rotateDuringForming) {
      this.group.rotation.y += this.rotationSpeedRad * step;
    }

    // --- Keep every nickname facing the camera so the text stays legible -----
    const camPos = this._resolveCameraPosition();
    for (const item of this._items) {
      if (typeof item.mesh.lookAt === 'function') {
        // NicknameMesh.lookAt delegates to object3d.lookAt, which compensates for
        // the spinning parent group's rotation, so the text faces the camera in
        // world space regardless of the current spin angle.
        item.mesh.lookAt(camPos);
      }
    }
  }

  /**
   * Resolve the current camera position into a world-space Vector3, supporting a
   * THREE.Camera, a plain `{x, y, z}` point, or a function returning either.
   * @returns {THREE.Vector3} The shared scratch vector holding the camera position.
   */
  _resolveCameraPosition() {
    const out = this._cameraPos;
    let src = typeof this.cameraTarget === 'function' ? this.cameraTarget() : this.cameraTarget;
    if (!src) return out.set(0, 0, 0);

    if (typeof src.getWorldPosition === 'function') {
      return src.getWorldPosition(out);
    }
    if (src.position && typeof src.position.x === 'number') {
      return out.set(src.position.x, src.position.y, src.position.z);
    }
    if (typeof src.x === 'number') {
      return out.set(src.x, src.y, src.z);
    }
    return out.set(0, 0, 0);
  }

  /**
   * Remove every nickname from the spinning group (without disposing the meshes,
   * which the caller owns) and detach the group from its parent.
   */
  dispose() {
    for (const item of this._items) {
      if (item.mesh.object3d) this.group.remove(item.mesh.object3d);
    }
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

/**
 * Smoothstep ease-in-out: 3t² − 2t³ on the clamped range [0, 1].
 * @param {number} t
 * @returns {number}
 */
function smoothstep(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

export default SphereFormation;
