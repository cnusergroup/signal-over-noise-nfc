/**
 * Unit tests for early bird processor.
 */

import { describe, it, expect, vi } from 'vitest';
import { processEarlyBird } from '../../src/mission-engine/early-bird.mjs';

function makeMission(overrides = {}) {
  return {
    PK: 'MISSION#eb1',
    SK: 'CONFIG',
    missionId: 'eb1',
    type: 'early_bird',
    stationId: 2,
    winnerCount: 5,
    bonusPoints: 100,
    ...overrides,
  };
}

function makeDeps(sendFn) {
  return {
    client: { send: sendFn },
    tableName: 'TestTable',
  };
}

describe('processEarlyBird', () => {
  it('returns existing bonus when tag already awarded (idempotency)', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({
      // GetItem returns existing entry with earlyBirdPosition
      Item: {
        PK: 'MISSION#eb1',
        SK: 'ENTRY#tag-abc',
        tagId: 'tag-abc',
        earlyBirdPosition: 3,
        bonusPoints: 100,
      },
    });
    const deps = makeDeps(sendMock);
    const mission = makeMission();

    const result = await processEarlyBird(mission, 'tag-abc', deps);

    expect(result).toEqual({
      missionId: 'eb1',
      position: 3,
      bonusPoints: 100,
      alreadyAwarded: true,
    });
    // Only one call: the GetItem check
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('awards bonus when position ≤ N (first visitor)', async () => {
    const sendMock = vi.fn()
      // 1. GetItem: no existing entry
      .mockResolvedValueOnce({ Item: undefined })
      // 2. UpdateItem: atomic counter returns position 1
      .mockResolvedValueOnce({ Attributes: { count: 1 } })
      // 3. PutItem: early bird slot
      .mockResolvedValueOnce({})
      // 4. PutItem: entry record
      .mockResolvedValueOnce({});

    const deps = makeDeps(sendMock);
    const mission = makeMission();

    const result = await processEarlyBird(mission, 'tag-new', deps);

    expect(result).toEqual({
      missionId: 'eb1',
      position: 1,
      bonusPoints: 100,
      awarded: true,
    });
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it('returns null when position > N (mission full)', async () => {
    const sendMock = vi.fn()
      // 1. GetItem: no existing entry
      .mockResolvedValueOnce({ Item: undefined })
      // 2. UpdateItem: counter returns position 6 (> winnerCount of 5)
      .mockResolvedValueOnce({ Attributes: { count: 6 } });

    const deps = makeDeps(sendMock);
    const mission = makeMission();

    const result = await processEarlyBird(mission, 'tag-late', deps);

    expect(result).toBeNull();
    // Only 2 calls: GetItem + UpdateItem (no writes)
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('transitions mission to completed when position === N', async () => {
    const sendMock = vi.fn()
      // 1. GetItem: no existing entry
      .mockResolvedValueOnce({ Item: undefined })
      // 2. UpdateItem: counter returns position 5 (=== winnerCount)
      .mockResolvedValueOnce({ Attributes: { count: 5 } })
      // 3. PutItem: early bird slot
      .mockResolvedValueOnce({})
      // 4. PutItem: entry record
      .mockResolvedValueOnce({})
      // 5. UpdateItem: transition mission to completed
      .mockResolvedValueOnce({});

    const deps = makeDeps(sendMock);
    const mission = makeMission();

    const result = await processEarlyBird(mission, 'tag-fifth', deps);

    expect(result).toEqual({
      missionId: 'eb1',
      position: 5,
      bonusPoints: 100,
      awarded: true,
    });
    // 5 calls: Get + Counter + Slot + Entry + Status update
    expect(sendMock).toHaveBeenCalledTimes(5);

    // Verify the status update command
    const statusCmd = sendMock.mock.calls[4][0];
    expect(statusCmd.input.Key).toEqual({ PK: 'MISSION#eb1', SK: 'CONFIG' });
    expect(statusCmd.input.ExpressionAttributeValues[':completed']).toBe('completed');
  });

  it('does not transition mission when position < N', async () => {
    const sendMock = vi.fn()
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Attributes: { count: 3 } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const deps = makeDeps(sendMock);
    const mission = makeMission();

    await processEarlyBird(mission, 'tag-third', deps);

    // Only 4 calls: no status update
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it('handles ConditionalCheckFailedException on entry write (race condition)', async () => {
    const condErr = new Error('Condition not met');
    condErr.name = 'ConditionalCheckFailedException';

    const sendMock = vi.fn()
      // 1. GetItem: no existing entry
      .mockResolvedValueOnce({ Item: undefined })
      // 2. UpdateItem: counter returns position 2
      .mockResolvedValueOnce({ Attributes: { count: 2 } })
      // 3. PutItem: early bird slot succeeds
      .mockResolvedValueOnce({})
      // 4. PutItem: entry record fails (race condition)
      .mockRejectedValueOnce(condErr)
      // 5. GetItem: re-read entry to get actual position
      .mockResolvedValueOnce({
        Item: {
          PK: 'MISSION#eb1',
          SK: 'ENTRY#tag-race',
          earlyBirdPosition: 1,
        },
      });

    const deps = makeDeps(sendMock);
    const mission = makeMission();

    const result = await processEarlyBird(mission, 'tag-race', deps);

    expect(result).toEqual({
      missionId: 'eb1',
      position: 1,
      bonusPoints: 100,
      alreadyAwarded: true,
    });
  });

  it('throws on unexpected DynamoDB errors', async () => {
    const err = new Error('Service unavailable');
    err.name = 'InternalServerError';

    const sendMock = vi.fn()
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Attributes: { count: 1 } })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(err);

    const deps = makeDeps(sendMock);
    const mission = makeMission();

    await expect(processEarlyBird(mission, 'tag-err', deps))
      .rejects.toThrow('Service unavailable');
  });

  it('extracts missionId from PK when missionId field is absent', async () => {
    const sendMock = vi.fn()
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Attributes: { count: 1 } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const deps = makeDeps(sendMock);
    const mission = { PK: 'MISSION#eb99', SK: 'CONFIG', type: 'early_bird', winnerCount: 10, bonusPoints: 50 };

    const result = await processEarlyBird(mission, 'tag-pk', deps);

    expect(result.missionId).toBe('eb99');
    expect(result.bonusPoints).toBe(50);
  });

  it('still awards bonus even if mission status transition fails', async () => {
    const statusErr = new Error('Throttled');
    statusErr.name = 'ProvisionedThroughputExceededException';

    const sendMock = vi.fn()
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Attributes: { count: 5 } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      // Status update fails
      .mockRejectedValueOnce(statusErr);

    const deps = makeDeps(sendMock);
    const mission = makeMission();

    // Should not throw — bonus is still awarded
    const result = await processEarlyBird(mission, 'tag-last', deps);

    expect(result).toEqual({
      missionId: 'eb1',
      position: 5,
      bonusPoints: 100,
      awarded: true,
    });
  });

  it('writes correct early bird slot record', async () => {
    const sendMock = vi.fn()
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Attributes: { count: 2 } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const deps = makeDeps(sendMock);
    const mission = makeMission();

    await processEarlyBird(mission, 'tag-slot', deps);

    // Verify the early bird slot PutItem (3rd call)
    const slotCmd = sendMock.mock.calls[2][0];
    expect(slotCmd.input.Item.PK).toBe('MISSION#eb1');
    expect(slotCmd.input.Item.SK).toBe('EARLYBIRD#2');
    expect(slotCmd.input.Item.tagId).toBe('tag-slot');
    expect(slotCmd.input.Item.position).toBe(2);
    expect(slotCmd.input.Item.bonusPoints).toBe(100);
    expect(slotCmd.input.Item.awardedAt).toBeDefined();
  });

  it('writes correct entry record with GSI keys', async () => {
    const sendMock = vi.fn()
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Attributes: { count: 1 } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const deps = makeDeps(sendMock);
    const mission = makeMission();

    await processEarlyBird(mission, 'tag-entry', deps);

    // Verify the entry PutItem (4th call)
    const entryCmd = sendMock.mock.calls[3][0];
    expect(entryCmd.input.Item.PK).toBe('MISSION#eb1');
    expect(entryCmd.input.Item.SK).toBe('ENTRY#tag-entry');
    expect(entryCmd.input.Item.tagId).toBe('tag-entry');
    expect(entryCmd.input.Item.earlyBirdPosition).toBe(1);
    expect(entryCmd.input.Item.GSI1PK).toBe('TAG#tag-entry');
    expect(entryCmd.input.Item.GSI1SK).toBe('MISSION#eb1');
    expect(entryCmd.input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });
});
