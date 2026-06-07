// Feature: after-party-lottery — sphere position generators for the 3D lottery animation.
//
// Provides Fibonacci-lattice unit-sphere point generation and a participant-count
// aware sphere radius, used by the SphereFormation module to arrange nickname
// meshes into a rotating sphere (Requirements 7.1, 7.5).

/**
 * Generate `n` points distributed (approximately) uniformly on the surface of a
 * unit sphere using a Fibonacci lattice.
 *
 * Every returned point has a Euclidean norm of 1 (within floating-point
 * tolerance), including the `n === 1` case, which the standard formula cannot
 * compute directly because it divides by `(n - 1)`.
 *
 * @param {number} n - Number of points to generate. Expected to be an integer `>= 1`.
 * @returns {Array<[number, number, number]>} An array of length `n`, where each
 *   element is an `[x, y, z]` triple lying on the unit sphere.
 */
export function fibonacciSphere(n) {
  const points = [];

  // The standard formula uses `i / (n - 1)`, which divides by zero for n === 1.
  // Place the single point at the north pole so it still has a unit norm.
  if (n <= 1) {
    if (n === 1) {
      points.push([0, 1, 0]);
    }
    return points;
  }

  const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle in radians
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2; // y from 1 down to -1
    const radius = Math.sqrt(Math.max(0, 1 - y * y)); // radius of the slice at height y
    const theta = phi * i;
    points.push([Math.cos(theta) * radius, y, Math.sin(theta) * radius]);
  }
  return points;
}

/**
 * Compute the sphere radius for a given participant count.
 *
 * For `n >= 10` the radius scales with `sqrt(n)` so the surface area grows with
 * the participant count. For `n < 10` (Requirement 7.5) the radius is reduced so
 * the few meshes remain visually dense rather than sparsely distributed.
 *
 * The function is monotonically non-decreasing in `n`.
 *
 * @param {number} n - Participant count.
 * @returns {number} The sphere radius in world units.
 */
export function sphereRadius(n) {
  if (n >= 10) {
    return Math.max(8, Math.sqrt(n) * 1.5);
  }
  return Math.max(4, n * 0.8);
}
