// Feature: after-party-lottery, Property 13: Nickname truncation rule
//
// Validates: Requirements 6.1
//
// Property 13 asserts that `truncateNickname` from `web/lottery/truncate.mjs`:
//   1. never returns a string longer than 20 characters,
//   2. is the identity function for inputs of length <= 20, and
//   3. returns `s.slice(0, 19) + '…'` for inputs of length > 20.
//
// `truncateNickname` and these properties both operate on JavaScript's native
// `String.length` (UTF-16 code units), so they are measured consistently.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { truncateNickname } from '../../truncate.mjs';

describe('Property 13: Nickname truncation rule', () => {
  // Branch-targeted generators avoid precondition-rejection blowups: rather than
  // generate arbitrary lengths and discard the wrong branch with `fc.pre`, we
  // generate directly within each branch's length range.
  const arbShort = fc.string({ maxLength: 20 }); // s.length <= 20
  const arbLong = fc.string({ minLength: 21, maxLength: 60 }); // s.length > 20
  // Covers both branches for the universal length bound.
  const arbAny = fc.oneof(arbShort, arbLong);

  it('never produces a result longer than 20 characters', () => {
    fc.assert(
      fc.property(arbAny, (s) => {
        expect(truncateNickname(s).length).toBeLessThanOrEqual(20);
      })
    );
  });

  it('is the identity function when s.length <= 20', () => {
    fc.assert(
      fc.property(arbShort, (s) => {
        expect(truncateNickname(s)).toBe(s);
      })
    );
  });

  it('returns s.slice(0, 19) + ellipsis when s.length > 20', () => {
    fc.assert(
      fc.property(arbLong, (s) => {
        expect(truncateNickname(s)).toBe(s.slice(0, 19) + '…');
      })
    );
  });
});
