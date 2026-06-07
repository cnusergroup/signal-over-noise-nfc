/**
 * Unit tests for the last-call recorder (src/mission-engine/last-call.mjs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recordLastCallEntry } from '../../src/mission-engine/last-call.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

const FIXED_TIME = new Date('2024-06-15T14:00:00.000Z').getTime();

describe('mission-engine/last-call recorder', () => {
  let mockClient;
  let deps;

  beforeEach(() => {
    setClock(() => FIXED_TIME);
    mockClient = {
      send: vi.fn().mockResolvedValue({}),
    };
    deps = { client: mockClient, tableName: 'TestTable' };
  });

  afterEach(() => {
    resetClock();
  });

  it('writes a LASTCALL entry with correct PK and SK', async () => {
    const mission = { missionId: 'mission-lc1' };
    const tagId = 'tag-abc';
    const checkinTime = '2024-06-15T13:55:00.000Z';

    await recordLastCallEntry(mission, tagId, checkinTime, deps);

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const putCommand = mockClient.send.mock.calls[0][0];
    expect(putCommand.input.TableName).toBe('TestTable');
    expect(putCommand.input.Item.PK).toBe('MISSION#mission-lc1');
    expect(putCommand.input.Item.SK).toBe('LASTCALL#tag-abc');
  });

  it('includes tagId, checkinTime, and updatedAt in the item', async () => {
    const mission = { missionId: 'mission-lc2' };
    const tagId = 'tag-xyz';
    const checkinTime = '2024-06-15T13:58:00.000Z';

    await recordLastCallEntry(mission, tagId, checkinTime, deps);

    const putCommand = mockClient.send.mock.calls[0][0];
    const item = putCommand.input.Item;
    expect(item.tagId).toBe('tag-xyz');
    expect(item.checkinTime).toBe('2024-06-15T13:58:00.000Z');
    expect(item.updatedAt).toBe(new Date(FIXED_TIME).toISOString());
  });

  it('returns { entered: true }', async () => {
    const mission = { missionId: 'mission-lc3' };
    const result = await recordLastCallEntry(mission, 'tag-1', '2024-06-15T13:50:00.000Z', deps);
    expect(result).toEqual({ entered: true });
  });

  it('uses PutItem without condition (upsert behavior)', async () => {
    const mission = { missionId: 'mission-lc4' };
    await recordLastCallEntry(mission, 'tag-1', '2024-06-15T13:50:00.000Z', deps);

    const putCommand = mockClient.send.mock.calls[0][0];
    // No ConditionExpression — this is an upsert
    expect(putCommand.input.ConditionExpression).toBeUndefined();
  });

  it('extracts missionId from PK when missionId field is absent', async () => {
    const mission = { PK: 'MISSION#pk-derived-id' };
    await recordLastCallEntry(mission, 'tag-1', '2024-06-15T13:50:00.000Z', deps);

    const putCommand = mockClient.send.mock.calls[0][0];
    expect(putCommand.input.Item.PK).toBe('MISSION#pk-derived-id');
  });

  it('overwrites previous entry for same tag (sliding window)', async () => {
    const mission = { missionId: 'mission-lc5' };
    const tagId = 'tag-repeat';

    // First call
    await recordLastCallEntry(mission, tagId, '2024-06-15T13:50:00.000Z', deps);
    // Second call with later timestamp
    await recordLastCallEntry(mission, tagId, '2024-06-15T13:55:00.000Z', deps);

    // Both calls should succeed (PutItem without condition = upsert)
    expect(mockClient.send).toHaveBeenCalledTimes(2);
    const secondPut = mockClient.send.mock.calls[1][0];
    expect(secondPut.input.Item.checkinTime).toBe('2024-06-15T13:55:00.000Z');
  });

  it('propagates DynamoDB errors', async () => {
    mockClient.send.mockRejectedValue(new Error('DynamoDB failure'));
    const mission = { missionId: 'mission-lc6' };

    await expect(
      recordLastCallEntry(mission, 'tag-1', '2024-06-15T13:50:00.000Z', deps)
    ).rejects.toThrow('DynamoDB failure');
  });
});
