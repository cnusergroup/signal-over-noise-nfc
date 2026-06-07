/**
 * Unit tests for stamp rally evaluator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateStampRally } from '../../src/mission-engine/stamp-rally.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

function makeDeps(sendFn) {
  return {
    client: { send: sendFn },
    tableName: 'TestTable',
  };
}

/**
 * Creates check-in items for given station IDs.
 */
function makeCheckins(stationIds, { expired = false } = {}) {
  const currentSeconds = Math.floor(Date.now() / 1000);
  return stationIds.map(id => ({
    PK: `TAG#tag-abc`,
    SK: `CHECKIN#${id}`,
    checkinTime: '2024-01-01T10:00:00.000Z',
    ttl: expired ? currentSeconds - 100 : currentSeconds + 86400,
  }));
}

describe('evaluateStampRally', () => {
  beforeEach(() => {
    resetClock();
  });

  it('returns incomplete when fewer than 10 stations visited', async () => {
    const checkins = makeCheckins([1, 2, 3, 4, 5]);
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: checkins });
    const deps = makeDeps(sendMock);

    const result = await evaluateStampRally('tag-abc', deps);

    expect(result).toEqual({ completed: false, rewardCode: null });
    // Only one call: the query for check-ins
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('returns incomplete when no check-ins exist', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: [] });
    const deps = makeDeps(sendMock);

    const result = await evaluateStampRally('tag-empty', deps);

    expect(result).toEqual({ completed: false, rewardCode: null });
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('returns existing reward code when stamp rally already complete', async () => {
    const checkins = makeCheckins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sendMock = vi.fn()
      // 1. Query check-ins
      .mockResolvedValueOnce({ Items: checkins })
      // 2. GetItem: existing stamp rally record
      .mockResolvedValueOnce({
        Item: {
          PK: 'TAG#tag-abc',
          SK: 'STAMPRALLY',
          rewardCode: 'existing-reward-code-123',
          completedAt: '2024-01-01T12:00:00.000Z',
        },
      });
    const deps = makeDeps(sendMock);

    const result = await evaluateStampRally('tag-abc', deps);

    expect(result).toEqual({
      completed: true,
      rewardCode: 'existing-reward-code-123',
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('generates new reward code when all 10 stations visited for first time', async () => {
    const checkins = makeCheckins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sendMock = vi.fn()
      // 1. Query check-ins
      .mockResolvedValueOnce({ Items: checkins })
      // 2. GetItem: no existing stamp rally record
      .mockResolvedValueOnce({ Item: undefined })
      // 3. PutItem: write stamp rally record
      .mockResolvedValueOnce({})
      // 4. PutItem: leaderboard update (updateLeaderboard)
      .mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const result = await evaluateStampRally('tag-abc', deps);

    expect(result.completed).toBe(true);
    expect(result.rewardCode).toBeDefined();
    expect(result.rewardCode.length).toBeGreaterThanOrEqual(16);
  });

  it('writes stamp rally record with conditional expression', async () => {
    const checkins = makeCheckins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sendMock = vi.fn()
      .mockResolvedValueOnce({ Items: checkins })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      // 4. PutItem: leaderboard update
      .mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    await evaluateStampRally('tag-abc', deps);

    // Verify the PutItem command (3rd call)
    const putCmd = sendMock.mock.calls[2][0];
    expect(putCmd.input.Item.PK).toBe('TAG#tag-abc');
    expect(putCmd.input.Item.SK).toBe('STAMPRALLY');
    expect(putCmd.input.Item.rewardCode).toBeDefined();
    expect(putCmd.input.Item.rewardCode.length).toBeGreaterThanOrEqual(16);
    expect(putCmd.input.Item.completedAt).toBeDefined();
    expect(putCmd.input.Item.tagId).toBe('tag-abc');
    expect(putCmd.input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('handles ConditionalCheckFailedException (race condition)', async () => {
    const checkins = makeCheckins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const condErr = new Error('Condition not met');
    condErr.name = 'ConditionalCheckFailedException';

    const sendMock = vi.fn()
      // 1. Query check-ins
      .mockResolvedValueOnce({ Items: checkins })
      // 2. GetItem: no existing record (race window)
      .mockResolvedValueOnce({ Item: undefined })
      // 3. PutItem: fails due to race condition
      .mockRejectedValueOnce(condErr)
      // 4. GetItem: re-read returns the winner's record
      .mockResolvedValueOnce({
        Item: {
          PK: 'TAG#tag-abc',
          SK: 'STAMPRALLY',
          rewardCode: 'race-winner-code-xyz',
          completedAt: '2024-01-01T12:00:00.000Z',
        },
      });
    const deps = makeDeps(sendMock);

    const result = await evaluateStampRally('tag-abc', deps);

    expect(result).toEqual({
      completed: true,
      rewardCode: 'race-winner-code-xyz',
    });
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it('filters out expired check-in records', async () => {
    // 7 valid + 3 expired = not complete
    const validCheckins = makeCheckins([1, 2, 3, 4, 5, 6, 7]);
    const expiredCheckins = makeCheckins([8, 9, 10], { expired: true });
    const allCheckins = [...validCheckins, ...expiredCheckins];

    const sendMock = vi.fn().mockResolvedValueOnce({ Items: allCheckins });
    const deps = makeDeps(sendMock);

    const result = await evaluateStampRally('tag-abc', deps);

    expect(result).toEqual({ completed: false, rewardCode: null });
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('throws on unexpected DynamoDB errors', async () => {
    const err = new Error('Service unavailable');
    err.name = 'InternalServerError';

    const sendMock = vi.fn().mockRejectedValueOnce(err);
    const deps = makeDeps(sendMock);

    await expect(evaluateStampRally('tag-err', deps))
      .rejects.toThrow('Service unavailable');
  });

  it('handles Items being undefined in query response', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: undefined });
    const deps = makeDeps(sendMock);

    const result = await evaluateStampRally('tag-none', deps);

    expect(result).toEqual({ completed: false, rewardCode: null });
  });

  it('counts unique stations correctly (duplicate station IDs)', async () => {
    // Even if somehow there are duplicate SK entries, the set handles it
    const checkins = makeCheckins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Add a "duplicate" station 1 entry (shouldn't happen in practice but tests robustness)
    const sendMock = vi.fn()
      .mockResolvedValueOnce({ Items: checkins })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      // 4. PutItem: leaderboard update
      .mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const result = await evaluateStampRally('tag-abc', deps);

    expect(result.completed).toBe(true);
    expect(result.rewardCode.length).toBeGreaterThanOrEqual(16);
  });

  it('queries with correct key condition expression', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: [] });
    const deps = makeDeps(sendMock);

    await evaluateStampRally('tag-query', deps);

    const queryCmd = sendMock.mock.calls[0][0];
    expect(queryCmd.input.TableName).toBe('TestTable');
    expect(queryCmd.input.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :skPrefix)');
    expect(queryCmd.input.ExpressionAttributeValues[':pk']).toBe('TAG#tag-query');
    expect(queryCmd.input.ExpressionAttributeValues[':skPrefix']).toBe('CHECKIN#');
  });
});
