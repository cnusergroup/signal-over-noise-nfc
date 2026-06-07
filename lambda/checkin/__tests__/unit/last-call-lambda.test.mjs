/**
 * Unit tests for the Last Call finalization Lambda logic.
 * Tests the handler by directly testing the algorithm (sort + select + write).
 * Since the Lambda is in a separate directory with its own node_modules,
 * we test the core logic by simulating the handler's behavior.
 */

import { describe, it, expect } from 'vitest';

/**
 * Simulates the core winner selection logic from the Last Call Lambda.
 * This mirrors the algorithm in lambda/last-call/index.mjs.
 */
function selectLastCallWinners(entries, winnerCount) {
  // Sort by checkinTime descending (most recent first)
  const sorted = [...entries].sort((a, b) => {
    const timeA = new Date(a.checkinTime).getTime();
    const timeB = new Date(b.checkinTime).getTime();
    return timeB - timeA;
  });

  // Select first N entries (the "last" N visitors)
  const winnersToSelect = Math.min(winnerCount, sorted.length);
  return sorted.slice(0, winnersToSelect);
}

describe('Last Call finalization logic', () => {
  describe('winner selection', () => {
    it('selects last N unique tags by most recent checkinTime', () => {
      const entries = [
        { tagId: 'tag-a', checkinTime: '2024-06-15T13:50:00.000Z' },
        { tagId: 'tag-b', checkinTime: '2024-06-15T13:55:00.000Z' },
        { tagId: 'tag-c', checkinTime: '2024-06-15T13:52:00.000Z' },
        { tagId: 'tag-d', checkinTime: '2024-06-15T13:58:00.000Z' },
      ];

      const winners = selectLastCallWinners(entries, 2);

      expect(winners.length).toBe(2);
      // Most recent first: tag-d (13:58), then tag-b (13:55)
      expect(winners[0].tagId).toBe('tag-d');
      expect(winners[1].tagId).toBe('tag-b');
    });

    it('selects all entries when entries < N', () => {
      const entries = [
        { tagId: 'tag-x', checkinTime: '2024-06-15T13:50:00.000Z' },
        { tagId: 'tag-y', checkinTime: '2024-06-15T13:55:00.000Z' },
      ];

      const winners = selectLastCallWinners(entries, 5);

      expect(winners.length).toBe(2);
      // Still sorted by most recent first
      expect(winners[0].tagId).toBe('tag-y');
      expect(winners[1].tagId).toBe('tag-x');
    });

    it('returns empty array when no entries exist', () => {
      const winners = selectLastCallWinners([], 3);
      expect(winners).toEqual([]);
    });

    it('selects exactly N when entries == N', () => {
      const entries = [
        { tagId: 'tag-1', checkinTime: '2024-06-15T13:50:00.000Z' },
        { tagId: 'tag-2', checkinTime: '2024-06-15T13:51:00.000Z' },
        { tagId: 'tag-3', checkinTime: '2024-06-15T13:52:00.000Z' },
      ];

      const winners = selectLastCallWinners(entries, 3);
      expect(winners.length).toBe(3);
    });

    it('handles single entry with N=1', () => {
      const entries = [
        { tagId: 'tag-solo', checkinTime: '2024-06-15T14:00:00.000Z' },
      ];

      const winners = selectLastCallWinners(entries, 1);
      expect(winners.length).toBe(1);
      expect(winners[0].tagId).toBe('tag-solo');
    });

    it('correctly orders entries with close timestamps', () => {
      const entries = [
        { tagId: 'tag-a', checkinTime: '2024-06-15T13:59:59.000Z' },
        { tagId: 'tag-b', checkinTime: '2024-06-15T13:59:59.500Z' },
        { tagId: 'tag-c', checkinTime: '2024-06-15T13:59:58.000Z' },
      ];

      const winners = selectLastCallWinners(entries, 2);
      expect(winners[0].tagId).toBe('tag-b'); // 59.5s
      expect(winners[1].tagId).toBe('tag-a'); // 59.0s
    });

    it('handles large number of entries', () => {
      const entries = Array.from({ length: 100 }, (_, i) => ({
        tagId: `tag-${i}`,
        checkinTime: new Date(Date.UTC(2024, 5, 15, 13, 0, i)).toISOString(),
      }));

      const winners = selectLastCallWinners(entries, 5);
      expect(winners.length).toBe(5);
      // Last 5 should be tags 99, 98, 97, 96, 95 (highest timestamps)
      expect(winners[0].tagId).toBe('tag-99');
      expect(winners[1].tagId).toBe('tag-98');
      expect(winners[2].tagId).toBe('tag-97');
      expect(winners[3].tagId).toBe('tag-96');
      expect(winners[4].tagId).toBe('tag-95');
    });
  });
});
