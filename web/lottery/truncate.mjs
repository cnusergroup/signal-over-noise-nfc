/**
 * Truncate a nickname for display in the 3D lottery animation.
 *
 * Returns the input unchanged when it is at most 20 characters long.
 * Otherwise returns the first 19 characters followed by a single
 * ellipsis character ('…', U+2026), yielding a string of length 20.
 *
 * @param {string} s - The nickname to truncate.
 * @returns {string} The original string when `s.length <= 20`, otherwise
 *   `s.slice(0, 19) + '…'`.
 */
export function truncateNickname(s) {
  if (s.length <= 20) {
    return s;
  }
  return s.slice(0, 19) + '…';
}
