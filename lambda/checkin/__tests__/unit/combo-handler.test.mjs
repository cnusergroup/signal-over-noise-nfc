/**
 * Unit tests for combo admin handler (POST/GET /combos).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleComboAdmin } from '../../src/combo-handler.mjs';

function makeDeps(sendFn) {
  return {
    client: { send: sendFn },
    tableName: 'TestTable',
  };
}

describe('handleComboAdmin - POST /combos (createCombo)', () => {
  it('creates a combo and returns 201 with name, stations, reward', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const result = await handleComboAdmin({
      method: 'POST',
      body: { name: 'Corner Trio', stations: [1, 3, 5], reward: 'Free coffee' },
    }, deps);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.name).toBe('Corner Trio');
    expect(body.stations).toEqual([1, 3, 5]);
    expect(body.reward).toBe('Free coffee');
  });

  it('writes correct DynamoDB item with PK=COMBO#{name}, SK=CONFIG, GSI1PK=COMBO_LIST', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    await handleComboAdmin({
      method: 'POST',
      body: { name: 'Full House', stations: [1, 2, 3, 4, 5], reward: 'Grand prize' },
    }, deps);

    const putCmd = sendMock.mock.calls[0][0];
    expect(putCmd.input.TableName).toBe('TestTable');
    expect(putCmd.input.Item.PK).toBe('COMBO#Full House');
    expect(putCmd.input.Item.SK).toBe('CONFIG');
    expect(putCmd.input.Item.GSI1PK).toBe('COMBO_LIST');
    expect(putCmd.input.Item.GSI1SK).toBe('Full House');
    expect(putCmd.input.Item.name).toBe('Full House');
    expect(putCmd.input.Item.stations).toEqual([1, 2, 3, 4, 5]);
    expect(putCmd.input.Item.reward).toBe('Grand prize');
    expect(putCmd.input.Item.createdAt).toBeDefined();
  });

  it('includes createdAt as ISO 8601 timestamp', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    await handleComboAdmin({
      method: 'POST',
      body: { name: 'Duo', stations: [2, 7], reward: 'Sticker' },
    }, deps);

    const putCmd = sendMock.mock.calls[0][0];
    const createdAt = putCmd.input.Item.createdAt;
    // Verify it's a valid ISO 8601 string
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });

  it('returns 500 on DynamoDB write failure', async () => {
    const sendMock = vi.fn().mockRejectedValueOnce(new Error('Service unavailable'));
    const deps = makeDeps(sendMock);

    const result = await handleComboAdmin({
      method: 'POST',
      body: { name: 'Broken', stations: [1, 2], reward: 'Nothing' },
    }, deps);

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('internal_error');
  });

  it('handles combo with minimum stations (2)', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const result = await handleComboAdmin({
      method: 'POST',
      body: { name: 'Pair', stations: [4, 9], reward: 'Badge' },
    }, deps);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.stations).toEqual([4, 9]);
  });

  it('handles combo with maximum stations (10)', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const result = await handleComboAdmin({
      method: 'POST',
      body: { name: 'All Stations', stations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], reward: 'Ultimate prize' },
    }, deps);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.stations).toHaveLength(10);
  });
});

describe('handleComboAdmin - GET /combos (listCombos)', () => {
  it('returns 200 with empty array when no combos exist', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: [], Count: 0 });
    const deps = makeDeps(sendMock);

    const result = await handleComboAdmin({ method: 'GET', action: 'list' }, deps);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toEqual([]);
  });

  it('returns all combo configurations', async () => {
    const items = [
      { name: 'Trio', stations: [1, 2, 3], reward: 'Coffee', PK: 'COMBO#Trio', SK: 'CONFIG', GSI1PK: 'COMBO_LIST', GSI1SK: 'Trio' },
      { name: 'Duo', stations: [5, 8], reward: 'Sticker', PK: 'COMBO#Duo', SK: 'CONFIG', GSI1PK: 'COMBO_LIST', GSI1SK: 'Duo' },
    ];
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: items, Count: 2 });
    const deps = makeDeps(sendMock);

    const result = await handleComboAdmin({ method: 'GET', action: 'list' }, deps);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({ name: 'Trio', stations: [1, 2, 3], reward: 'Coffee' });
    expect(body[1]).toEqual({ name: 'Duo', stations: [5, 8], reward: 'Sticker' });
  });

  it('strips internal DynamoDB attributes from response', async () => {
    const items = [
      { name: 'Test', stations: [3, 7], reward: 'Prize', PK: 'COMBO#Test', SK: 'CONFIG', GSI1PK: 'COMBO_LIST', GSI1SK: 'Test', createdAt: '2024-01-01T00:00:00.000Z' },
    ];
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: items, Count: 1 });
    const deps = makeDeps(sendMock);

    const result = await handleComboAdmin({ method: 'GET', action: 'list' }, deps);
    const body = JSON.parse(result.body);

    // Should only have name, stations, reward — no PK, SK, GSI keys, or createdAt
    expect(body[0]).toEqual({ name: 'Test', stations: [3, 7], reward: 'Prize' });
    expect(body[0].PK).toBeUndefined();
    expect(body[0].SK).toBeUndefined();
    expect(body[0].GSI1PK).toBeUndefined();
    expect(body[0].createdAt).toBeUndefined();
  });

  it('queries GSI1 with correct parameters (GSI1PK=COMBO_LIST)', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: [], Count: 0 });
    const deps = makeDeps(sendMock);

    await handleComboAdmin({ method: 'GET', action: 'list' }, deps);

    const queryCmd = sendMock.mock.calls[0][0];
    expect(queryCmd.input.TableName).toBe('TestTable');
    expect(queryCmd.input.IndexName).toBe('GSI1');
    expect(queryCmd.input.KeyConditionExpression).toContain('GSI1PK = :gsiPk');
    expect(queryCmd.input.ExpressionAttributeValues[':gsiPk']).toBe('COMBO_LIST');
  });

  it('returns 500 on DynamoDB query failure', async () => {
    const sendMock = vi.fn().mockRejectedValueOnce(new Error('Throttled'));
    const deps = makeDeps(sendMock);

    const result = await handleComboAdmin({ method: 'GET', action: 'list' }, deps);

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('internal_error');
  });
});
