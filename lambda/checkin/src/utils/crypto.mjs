/**
 * Crypto utilities — reward code generation and tag ID masking.
 */

import { randomBytes } from 'node:crypto';

/**
 * Generates a cryptographically secure reward code.
 * Returns a hex-encoded string of exactly `length` characters.
 * Default length is 20 (exceeds the 16+ character requirement).
 *
 * @param {number} [length=20] - Exact character length of the reward code
 * @returns {string} Hex-encoded reward code of exactly `length` characters
 */
export function generateRewardCode(length = 20) {
  const bytes = Math.ceil(length / 2);
  return randomBytes(bytes).toString('hex').slice(0, length);
}

/**
 * Masks a tag ID for leaderboard display.
 * Shows first 4 and last 4 characters, middle replaced with "****".
 *
 * For IDs with 8 or fewer characters, returns the ID unchanged
 * (not enough characters to meaningfully mask).
 *
 * @param {string} tagId - Full tag identifier
 * @returns {string} Masked tag identifier
 */
export function maskTagId(tagId) {
  if (!tagId || tagId.length <= 8) {
    return tagId;
  }
  const first = tagId.slice(0, 4);
  const last = tagId.slice(-4);
  return `${first}****${last}`;
}
