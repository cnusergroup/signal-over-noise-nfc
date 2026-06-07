// Feature: after-party-lottery, Property 16: Reveal-phase opacity invariants
//
// Validates: Requirements 8.4, 8.5, 8.7
//
// Property 16 drives the WinnerReveal animation to its exact terminal frame in a
// plain Node environment using lightweight mock meshes that implement the
// NicknameMesh surface the reveal touches (`material{opacity,color}`, `scale`,
// `position`, `intensity`, and the `setIntensity/setOpacity/setColor/setScale/
// setPosition` setters). No WebGL renderer or `three` import is required —
// winner-reveal.mjs only reads/writes mesh state through that API and advances
// its tweens via `update(dt)`.
//
// Property 16a — Terminal reveal frame (Requirements 8.4, 8.5): for any pool P
//   and any winner W in P, after the reveal tween completes:
//     - W.material.opacity === 1.0   (the winner stays fully opaque)
//     - W.scale.x >= 3.0             (scaled up to >= 3x base)
//     - W.material.color === #7df9ff (recolored to the signal cyan)
//     - every other mesh m in P \ {W} has m.material.opacity <= 0.2 (dimmed)
//
// Property 16b — Subsequent-reveal hand-off (Requirement 8.7): for any second,
//   distinct winner W2, at the moment W2's reveal STARTS (before its tween
//   advances): the previous winner W is returned to the sphere at opacity 0.5,
//   every other mesh (P \ {W}) is restored to opacity 1.0, and the noise
//   `uIntensity` is restored to 1.0 on ALL meshes prior to dissolving for W2.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { WinnerReveal, WINNER_COLOR } from '../../winner-reveal.mjs';

/** The signal cyan the winner is recolored to (#7df9ff, Requirement 8.4). */
const SIGNAL_CYAN = 0x7df9ff;

/** Clamp a number to the inclusive range [0, 1] (mirrors NicknameMesh.clamp01). */
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * A minimal stand-in for THREE.Color exposing just enough surface for the reveal:
 * 8-bit-derived `r`/`g`/`b` channels in [0, 1], a `set(hex)` mutator, and
 * `getHex()` so assertions can compare against #7df9ff exactly.
 */
class MockColor {
  /** @param {number} hex - Initial color as a 24-bit RGB integer. */
  constructor(hex = 0xeaffff) {
    this.set(hex);
  }

  /**
   * Set the color from a 24-bit RGB integer (the only form winner-reveal.mjs
   * passes to setColor).
   * @param {number} hex
   * @returns {this}
   */
  set(hex) {
    const h = (typeof hex === 'number' ? hex : 0) & 0xffffff;
    this._hex = h;
    this.r = ((h >> 16) & 0xff) / 255;
    this.g = ((h >> 8) & 0xff) / 255;
    this.b = (h & 0xff) / 255;
    return this;
  }

  /** @returns {number} The 24-bit RGB integer for this color. */
  getHex() {
    return this._hex;
  }
}

/**
 * A NicknameMesh-like mock recording the state the reveal manipulates. Mirrors
 * the real NicknameMesh getters/setters so WinnerReveal cannot tell the
 * difference, but holds plain data so the test can assert the terminal frame.
 */
class MockMesh {
  /**
   * @param {string} nickname
   * @param {object} [init]
   * @param {number} [init.color=0xeaffff]
   * @param {number} [init.opacity=1.0]
   * @param {number} [init.scale=1.0]
   * @param {number} [init.intensity=1.0]
   * @param {number} [init.x=0]
   * @param {number} [init.y=0]
   * @param {number} [init.z=0]
   */
  constructor(nickname, init = {}) {
    const {
      color = 0xeaffff,
      opacity = 1.0,
      scale = 1.0,
      intensity = 1.0,
      x = 0,
      y = 0,
      z = 0,
    } = init;
    this.nickname = nickname;
    this.material = { color: new MockColor(color), opacity: clamp01(opacity), transparent: true };
    this.scale = { x: scale, y: scale, z: scale };
    this.position = { x, y, z };
    this.intensity = clamp01(intensity);
  }

  setIntensity(v) {
    this.intensity = clamp01(v);
    return this;
  }

  setOpacity(v) {
    this.material.opacity = clamp01(v);
    this.material.transparent = true;
    return this;
  }

  setColor(hex) {
    this.material.color.set(hex);
    return this;
  }

  setScale(v) {
    this.scale.x = this.scale.y = this.scale.z = v;
    return this;
  }

  setPosition(x, y, z) {
    this.position.x = x;
    this.position.y = y;
    this.position.z = z;
    return this;
  }
}

/** Build `n` default-state mock meshes representing the idle sphere. */
function buildMeshes(n) {
  const meshes = [];
  for (let i = 0; i < n; i++) {
    meshes.push(new MockMesh(`p${i}`));
  }
  return meshes;
}

// Generate a pool size plus a winner index, and a second distinct winner index.
// `w2Raw` is folded into a guaranteed-distinct index inside each property.
const poolArb = fc
  .integer({ min: 2, max: 40 })
  .chain((n) =>
    fc.record({
      n: fc.constant(n),
      wi: fc.integer({ min: 0, max: n - 1 }),
      w2Raw: fc.integer({ min: 0, max: n - 1 }),
    }),
  );

describe('Property 16: Reveal-phase opacity invariants', () => {
  it('16a — terminal reveal frame: winner opaque + scaled + cyan, others dimmed <= 0.2', () => {
    fc.assert(
      fc.property(poolArb, ({ n, wi }) => {
        const meshes = buildMeshes(n);
        const winner = meshes[wi];

        const reveal = new WinnerReveal();
        reveal.revealWinner(winner, meshes);
        // Advance past the 1.5 s reveal duration so it snaps to the terminal frame.
        reveal.update(2);

        // Winner stays fully opaque (Requirement 8.4).
        expect(winner.material.opacity).toBe(1.0);
        // Winner scaled to >= 3x base (Requirement 8.4).
        expect(winner.scale.x).toBeGreaterThanOrEqual(3.0);
        // Winner recolored to the signal cyan #7df9ff (Requirement 8.4).
        expect(winner.material.color.getHex()).toBe(SIGNAL_CYAN);
        expect(winner.material.color.getHex()).toBe(WINNER_COLOR);

        // Every other mesh dimmed to <= 0.2 (Requirement 8.5).
        for (const m of meshes) {
          if (m !== winner) {
            expect(m.material.opacity).toBeLessThanOrEqual(0.2);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('16b — subsequent reveal hand-off: prev winner 0.5, others 1.0, all uIntensity 1.0', () => {
    fc.assert(
      fc.property(poolArb, ({ n, wi, w2Raw }) => {
        const meshes = buildMeshes(n);
        const winner = meshes[wi];
        // Fold w2Raw into an index guaranteed distinct from wi.
        const w2i = w2Raw === wi ? (wi + 1) % n : w2Raw;
        const winner2 = meshes[w2i];

        const reveal = new WinnerReveal();

        // Complete the first reveal of W.
        reveal.revealWinner(winner, meshes);
        reveal.update(2);

        // Begin the reveal of a different winner W2. Assert the hand-off state
        // synchronously at the START, before advancing the new tween.
        reveal.revealWinner(winner2, meshes);

        // Previous winner returned to the sphere at 50% opacity (Requirement 8.7).
        expect(winner.material.opacity).toBe(0.5);

        // Every other mesh restored to full opacity (Requirement 8.7).
        for (const m of meshes) {
          if (m !== winner) {
            expect(m.material.opacity).toBe(1.0);
          }
        }

        // Noise re-applied: uIntensity restored to 1.0 on ALL meshes before the
        // dissolve for W2 (Requirement 8.7).
        for (const m of meshes) {
          expect(m.intensity).toBe(1.0);
        }
      }),
      { numRuns: 200 },
    );
  });
});
