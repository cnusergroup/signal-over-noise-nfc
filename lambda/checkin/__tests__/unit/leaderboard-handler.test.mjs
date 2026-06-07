/**
 * Unit tests for leaderboard handler and updater.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLeaderboard, updateLeaderboard } from '../../src/leaderboard-handler.mjs';

function makeDeps(sendFn) {
  return {
    client: { send: sendFn },
    tableName: 'TestTable',
  };
}

describe('handleLeaderboard', () => {
  it('returns empty list when no leaderboard entries exist', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: [], Count: 0 });
    const deps = makeDeps(sendMock);

    const result = await handleLeaderboard(deps);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.totalEntries).toBe(0);
  });

  it('returns up to 20 entries sorted by elapsed time ascending', async () => {
    const items = [
      { tagId: 'abcdefghijklmnop', elapsedSeconds: 120, completedAt: '2024-01-01T10:02:00.000Z' },
      { tagId: 'qrstuvwxyz123456', elapsedSeconds: 300, completedAt: '2024-01-01T10:05:00.000Z' },
    ];
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: items, Count: 2 });
    const deps = makeDeps(sendMock);

    const result = await handleLeaderboard(deps);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].maskedTagId).toBe('abcd****mnop');
    expect(body.entries[0].elapsedSeconds).toBe(120);
    expect(body.entries[0].completedAt).toBe('2024-01-01T10:02:00.000Z');
    expect(body.entries[1].maskedTagId).toBe('qrst****3456');
    expect(body.entries[1].elapsedSeconds).toBe(300);
    expect(body.totalEntries).toBe(2);
  });

  it('masks tagId correctly (first 4 + **** + last 4)', async () => {
    const items = [
      { tagId: 'ABCD1234WXYZ5678', elapsedSeconds: 60, completedAt: '2024-01-01T10:01:00.000Z' },
    ];
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: items, Count: 1 });
    const deps = makeDeps(sendMock);

    const result = await handleLeaderboard(deps);
    const body = JSON.parse(result.body);

    expect(body.entries[0].maskedTagId).toBe('ABCD****5678');
  });

  it('queries with correct parameters (PK=LEADERBOARD, SK begins_with ENTRY#, limit 20, ascending)', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: [], Count: 0 });
    const deps = makeDeps(sendMock);

    await handleLeaderboard(deps);

    const queryCmd = sendMock.mock.calls[0][0];
    expect(queryCmd.input.TableName).toBe('TestTable');
    expect(queryCmd.input.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :skPrefix)');
    expect(queryCmd.input.ExpressionAttributeValues[':pk']).toBe('LEADERBOARD');
    expect(queryCmd.input.ExpressionAttributeValues[':skPrefix']).toBe('ENTRY#');
    expect(queryCmd.input.ScanIndexForward).toBe(true);
    expect(queryCmd.input.Limit).toBe(20);
  });

  it('performs count query when exactly 20 items returned', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      tagId: `tag-${String(i).padStart(12, '0')}pad`,
      elapsedSeconds: (i + 1) * 10,
      completedAt: `2024-01-01T10:${String(i).padStart(2, '0')}:00.000Z`,
    }));
    const sendMock = vi.fn()
      .mockResolvedValueOnce({ Items: items, Count: 20 })
      .mockResolvedValueOnce({ Count: 35 }); // total count query
    const deps = makeDeps(sendMock);

    const result = await handleLeaderboard(deps);
    const body = JSON.parse(result.body);

    expect(body.entries).toHaveLength(20);
    expect(body.totalEntries).toBe(35);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('returns 500 on DynamoDB error', async () => {
    const sendMock = vi.fn().mockRejectedValueOnce(new Error('Service unavailable'));
    const deps = makeDeps(sendMock);

    const result = await handleLeaderboard(deps);

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('internal_error');
  });

  it('handles short tagIds without masking', async () => {
    const items = [
      { tagId: 'short', elapsedSeconds: 42, completedAt: '2024-01-01T10:00:42.000Z' },
    ];
    const sendMock = vi.fn().mockResolvedValueOnce({ Items: items, Count: 1 });
    const deps = makeDeps(sendMock);

    const result = await handleLeaderboard(deps);
    const body = JSON.parse(result.body);

    // tagId with 5 chars (<=8) is returned unchanged
    expect(body.entries[0].maskedTagId).toBe('short');
  });
});

describe('updateLeaderboard', () => {
  it('calculates elapsed time correctly (max - min in whole seconds, truncated)', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const timestamps = [
      '2024-01-01T10:00:00.000Z',
      '2024-01-01T10:00:30.500Z',
      '2024-01-01T10:01:00.000Z',
    ];

    const result = await updateLeaderboard('tag-abc', timestamps, deps);

    expect(result.elapsedSeconds).toBe(60); // 60 seconds between first and last
    expect(result.completedAt).toBe('2024-01-01T10:01:00.000Z');
  });

  it('truncates elapsed seconds (does not round)', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const timestamps = [
      '2024-01-01T10:00:00.000Z',
      '2024-01-01T10:00:42.999Z', // 42.999 seconds
    ];

    const result = await updateLeaderboard('tag-trunc', timestamps, deps);

    expect(result.elapsedSeconds).toBe(42); // truncated, not 43
  });

  it('writes correct DynamoDB item with padded elapsed seconds in SK', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const timestamps = [
      '2024-01-01T10:00:00.000Z',
      '2024-01-01T10:00:42.000Z',
    ];

    await updateLeaderboard('tag-xyz', timestamps, deps);

    const putCmd = sendMock.mock.calls[0][0];
    expect(putCmd.input.TableName).toBe('TestTable');
    expect(putCmd.input.Item.PK).toBe('LEADERBOARD');
    expect(putCmd.input.Item.SK).toBe('ENTRY#000042#tag-xyz');
    expect(putCmd.input.Item.tagId).toBe('tag-xyz');
    expect(putCmd.input.Item.elapsedSeconds).toBe(42);
    expect(putCmd.input.Item.completedAt).toBe('2024-01-01T10:00:42.000Z');
    expect(putCmd.input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('pads elapsed seconds to 6 digits', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const timestamps = [
      '2024-01-01T10:00:00.000Z',
      '2024-01-01T10:00:05.000Z',
    ];

    await updateLeaderboard('tag-fast', timestamps, deps);

    const putCmd = sendMock.mock.calls[0][0];
    expect(putCmd.input.Item.SK).toBe('ENTRY#000005#tag-fast');
  });

  it('returns null when entry already exists (ConditionalCheckFailedException)', async () => {
    const condErr = new Error('Condition not met');
    condErr.name = 'ConditionalCheckFailedException';
    const sendMock = vi.fn().mockRejectedValueOnce(condErr);
    const deps = makeDeps(sendMock);

    const timestamps = [
      '2024-01-01T10:00:00.000Z',
      '2024-01-01T10:01:00.000Z',
    ];

    const result = await updateLeaderboard('tag-dup', timestamps, deps);

    expect(result).toBeNull();
  });

  it('returns null when timestamps array is empty', async () => {
    const sendMock = vi.fn();
    const deps = makeDeps(sendMock);

    const result = await updateLeaderboard('tag-empty', [], deps);

    expect(result).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns null when timestamps is null/undefined', async () => {
    const sendMock = vi.fn();
    const deps = makeDeps(sendMock);

    const result = await updateLeaderboard('tag-null', null, deps);

    expect(result).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('throws on unexpected DynamoDB errors', async () => {
    const err = new Error('Service unavailable');
    err.name = 'InternalServerError';
    const sendMock = vi.fn().mockRejectedValueOnce(err);
    const deps = makeDeps(sendMock);

    const timestamps = [
      '2024-01-01T10:00:00.000Z',
      '2024-01-01T10:01:00.000Z',
    ];

    await expect(updateLeaderboard('tag-err', timestamps, deps))
      .rejects.toThrow('Service unavailable');
  });

  it('handles single timestamp (elapsed = 0)', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    const timestamps = ['2024-01-01T10:00:00.000Z'];

    const result = await updateLeaderboard('tag-single', timestamps, deps);

    expect(result.elapsedSeconds).toBe(0);
    const putCmd = sendMock.mock.calls[0][0];
    expect(putCmd.input.Item.SK).toBe('ENTRY#000000#tag-single');
  });

  it('uses completedAt as the latest timestamp', async () => {
    const sendMock = vi.fn().mockResolvedValueOnce({});
    const deps = makeDeps(sendMock);

    // Timestamps not in order
    const timestamps = [
      '2024-01-01T10:05:00.000Z',
      '2024-01-01T10:00:00.000Z',
      '2024-01-01T10:10:00.000Z',
      '2024-01-01T10:02:00.000Z',
    ];

    const result = await updateLeaderboard('tag-order', timestamps, deps);

    expect(result.elapsedSeconds).toBe(600); // 10 minutes
    expect(result.completedAt).toBe('2024-01-01T10:10:00.000Z');
  });
});
