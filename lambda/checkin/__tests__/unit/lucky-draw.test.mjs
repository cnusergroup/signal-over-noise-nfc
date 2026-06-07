/**
 * Unit tests for lucky draw recorder.
 */

import { describe, it, expect, vi } from 'vitest';
import { recordLuckyDrawEntry } from '../../src/mission-engine/lucky-draw.mjs';

function makeMission(overrides = {}) {
  return {
    PK: 'MISSION#draw1',
    SK: 'CONFIG',
    missionId: 'draw1',
    type: 'lucky_draw',
    stationId: 3,
    ...overrides,
  };
}

function makeDeps(sendFn) {
  return {
    client: { send: sendFn },
    tableName: 'TestTable',
  };
}

describe('recordLuckyDrawEntry', () => {
  it('records a new entry and returns entered:true, alreadyEntered:false', async () => {
    const sendMock = vi.fn().mockResolvedValue({});
    const deps = makeDeps(sendMock);
    const mission = makeMission();

    const result = await recordLuckyDrawEntry(mission, 'tag-abc', deps);

    expect(result).toEqual({ entered: true, alreadyEntered: false });
    expect(sendMock).toHaveBeenCalledOnce();

    const command = sendMock.mock.calls[0][0];
    expect(command.input.TableName).toBe('TestTable');
    expect(command.input.Item.PK).toBe('MISSION#draw1');
    expect(command.input.Item.SK).toBe('ENTRY#tag-abc');
    expect(command.input.Item.tagId).toBe('tag-abc');
    expect(command.input.Item.GSI1PK).toBe('TAG#tag-abc');
    expect(command.input.Item.GSI1SK).toBe('MISSION#draw1');
    expect(command.input.Item.enteredAt).toBeDefined();
    expect(command.input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('returns entered:true, alreadyEntered:true when entry already exists', async () => {
    const err = new Error('Condition not met');
    err.name = 'ConditionalCheckFailedException';
    const sendMock = vi.fn().mockRejectedValue(err);
    const deps = makeDeps(sendMock);
    const mission = makeMission();

    const result = await recordLuckyDrawEntry(mission, 'tag-abc', deps);

    expect(result).toEqual({ entered: true, alreadyEntered: true });
  });

  it('throws on unexpected DynamoDB errors', async () => {
    const err = new Error('Service unavailable');
    err.name = 'InternalServerError';
    const sendMock = vi.fn().mockRejectedValue(err);
    const deps = makeDeps(sendMock);
    const mission = makeMission();

    await expect(recordLuckyDrawEntry(mission, 'tag-abc', deps))
      .rejects.toThrow('Service unavailable');
  });

  it('extracts missionId from PK when missionId field is absent', async () => {
    const sendMock = vi.fn().mockResolvedValue({});
    const deps = makeDeps(sendMock);
    const mission = { PK: 'MISSION#draw99', SK: 'CONFIG', type: 'lucky_draw' };

    const result = await recordLuckyDrawEntry(mission, 'tag-xyz', deps);

    expect(result).toEqual({ entered: true, alreadyEntered: false });
    const command = sendMock.mock.calls[0][0];
    expect(command.input.Item.PK).toBe('MISSION#draw99');
    expect(command.input.Item.SK).toBe('ENTRY#tag-xyz');
    expect(command.input.Item.GSI1SK).toBe('MISSION#draw99');
  });

  it('includes enteredAt as a valid ISO 8601 timestamp', async () => {
    const sendMock = vi.fn().mockResolvedValue({});
    const deps = makeDeps(sendMock);
    const mission = makeMission();

    await recordLuckyDrawEntry(mission, 'tag-ts', deps);

    const command = sendMock.mock.calls[0][0];
    const enteredAt = command.input.Item.enteredAt;
    // Verify it's a valid ISO date
    expect(new Date(enteredAt).toISOString()).toBe(enteredAt);
  });
});
