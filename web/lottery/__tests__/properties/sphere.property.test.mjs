// Feature: after-party-lottery, Property 15: Sphere position generator
//
// Validates: Requirements 7.1, 7.5
//
// Property 15a — Point count and unit norm: for any integer n in [1, 1000],
//   fibonacciSphere(n) returns exactly n points, and every point's Euclidean
//   norm lies within [0.99, 1.01] (i.e. the points sit on the unit sphere within
//   floating-point tolerance). This underpins the sphere arrangement of nickname
//   meshes (Requirement 7.1).
// Property 15b — Radius monotonicity: sphereRadius is monotonically non-decreasing
//   on the integer range [1, 500], so adding participants never shrinks the sphere.
//   This keeps the sphere visually dense for small n (Requirement 7.5) while growing
//   smoothly as participants are added.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { fibonacciSphere, sphereRadius } from '../../sphere.mjs';

/**
 * Euclidean norm of a 3D point.
 * @param {[number, number, number]} point - The [x, y, z] triple.
 * @returns {number} sqrt(x^2 + y^2 + z^2)
 */
function norm([x, y, z]) {
  return Math.sqrt(x * x + y * y + z * z);
}

describe('Property 15: Sphere position generator', () => {
  it('15a — fibonacciSphere(n) returns n unit-norm points for n in [1, 1000]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
        const points = fibonacciSphere(n);

        expect(points.length).toBe(n);

        for (const point of points) {
          const r = norm(point);
          expect(r).toBeGreaterThanOrEqual(0.99);
          expect(r).toBeLessThanOrEqual(1.01);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('15b — sphereRadius is monotonically non-decreasing on [1, 500]', () => {
    for (let n = 1; n < 500; n++) {
      expect(sphereRadius(n + 1)).toBeGreaterThanOrEqual(sphereRadius(n));
    }
  });
});
