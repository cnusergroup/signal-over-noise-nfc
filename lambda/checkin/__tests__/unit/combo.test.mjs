/**
 * Unit tests for combo evaluator.
 */

import { describe, it, expect, vi } from 'vitest';
import { evaluateCombos } from '../../src/mission-engine/combo.mjs';

/**
 * Creates a mock DynamoDB client that responds based on the operation.
 */
function createMockClient(options = {}) {
  const {
    combos = [],
    checkins = [],
    existingAwards = [],
    putErrors = {},
  } = options;

  return {
    send: vi.fn(async (command) => {
      const commandName = command.constructor.name;

      if (commandName === 'QueryCommand') {
        const input = command.input;

        // GSI1 query for COMBO_LIST
        if (input.IndexName === 'GSI1' && input.ExpressionAttributeValues[':gsiPk'] === 'COMBO_LIST') {
          return { Items: combos };
        }

        // Base table query for tag check-ins
        if (input.ExpressionAttributeValues[':pk'] && input.ExpressionAttributeValues[':skPrefix'] === 'CHECKIN#') {
          return { Items: checkins };
        }

        return { Items: [] };
      }

      if (commandName === 'GetCommand') {
        const input = command.input;
        const key = `${input.Key.PK}|${input.Key.SK}`;
        const found = existingAwards.find(a => `TAG#${a.tagId}|COMBO#${a.comboName}` === key);
        return { Item: found ? { PK: input.Key.PK, SK: input.Key.SK } : undefined };
      }

      if (commandName === 'PutCommand') {
        const input = command.input;
        const comboName = input.Item.comboName;
        if (putErrors[comboName]) {
          const err = new Error('Conditional check failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        return {};
      }

      return {};
    }),
  };
}

describe('evaluateCombos', () => {
  const tableName = 'TestTable';

  it('returns empty array when no combos are defined', async () => {
    const client = createMockClient({ combos: [] });
    const result = await evaluateCombos('tag1', new Set([1, 2, 3]), { client, tableName });
    expect(result).toEqual([]);
  });

  it('returns empty array when visited stations do not satisfy any combo', async () => {
    const combos = [
      { name: 'TripleA', stations: [1, 2, 3], reward: 'Prize A' },
    ];
    const client = createMockClient({ combos });
    const result = await evaluateCombos('tag1', new Set([1, 2]), { client, tableName });
    expect(result).toEqual([]);
  });

  it('awards a combo when visited stations are a superset of required stations', async () => {
    const combos = [
      { name: 'TripleA', stations: [1, 2, 3], reward: 'Prize A' },
    ];
    const client = createMockClient({ combos });
    const result = await evaluateCombos('tag1', new Set([1, 2, 3, 4]), { client, tableName });
    expect(result).toEqual([
      { comboName: 'TripleA', reward: 'Prize A', stations: [1, 2, 3] },
    ]);
  });

  it('does not re-award a combo that was already awarded', async () => {
    const combos = [
      { name: 'TripleA', stations: [1, 2, 3], reward: 'Prize A' },
    ];
    const existingAwards = [{ tagId: 'tag1', comboName: 'TripleA' }];
    const client = createMockClient({ combos, existingAwards });
    const result = await evaluateCombos('tag1', new Set([1, 2, 3, 4]), { client, tableName });
    expect(result).toEqual([]);
  });

  it('handles ConditionalCheckFailedException gracefully (concurrent award)', async () => {
    const combos = [
      { name: 'TripleA', stations: [1, 2, 3], reward: 'Prize A' },
    ];
    const client = createMockClient({ combos, putErrors: { TripleA: true } });
    const result = await evaluateCombos('tag1', new Set([1, 2, 3]), { client, tableName });
    // Should not include the combo since the conditional write failed
    expect(result).toEqual([]);
  });

  it('awards multiple combos when multiple are satisfied', async () => {
    const combos = [
      { name: 'TripleA', stations: [1, 2, 3], reward: 'Prize A' },
      { name: 'PairB', stations: [4, 5], reward: 'Prize B' },
      { name: 'BigC', stations: [1, 2, 3, 4, 5, 6], reward: 'Prize C' },
    ];
    const client = createMockClient({ combos });
    const result = await evaluateCombos('tag1', new Set([1, 2, 3, 4, 5]), { client, tableName });
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ comboName: 'TripleA', reward: 'Prize A', stations: [1, 2, 3] });
    expect(result).toContainEqual({ comboName: 'PairB', reward: 'Prize B', stations: [4, 5] });
  });

  it('queries visited stations from DynamoDB when not provided', async () => {
    const combos = [
      { name: 'TripleA', stations: [1, 2, 3], reward: 'Prize A' },
    ];
    const checkins = [
      { PK: 'TAG#tag1', SK: 'CHECKIN#1', ttl: Math.floor(Date.now() / 1000) + 86400 },
      { PK: 'TAG#tag1', SK: 'CHECKIN#2', ttl: Math.floor(Date.now() / 1000) + 86400 },
      { PK: 'TAG#tag1', SK: 'CHECKIN#3', ttl: Math.floor(Date.now() / 1000) + 86400 },
    ];
    const client = createMockClient({ combos, checkins });
    const result = await evaluateCombos('tag1', undefined, { client, tableName });
    expect(result).toEqual([
      { comboName: 'TripleA', reward: 'Prize A', stations: [1, 2, 3] },
    ]);
  });

  it('filters out expired check-in records when querying visited stations', async () => {
    const combos = [
      { name: 'TripleA', stations: [1, 2, 3], reward: 'Prize A' },
    ];
    const checkins = [
      { PK: 'TAG#tag1', SK: 'CHECKIN#1', ttl: Math.floor(Date.now() / 1000) + 86400 },
      { PK: 'TAG#tag1', SK: 'CHECKIN#2', ttl: Math.floor(Date.now() / 1000) + 86400 },
      { PK: 'TAG#tag1', SK: 'CHECKIN#3', ttl: 1 }, // expired
    ];
    const client = createMockClient({ combos, checkins });
    const result = await evaluateCombos('tag1', undefined, { client, tableName });
    // Station 3 is expired, so combo is not satisfied
    expect(result).toEqual([]);
  });

  it('skips combos with invalid/empty stations array', async () => {
    const combos = [
      { name: 'BadCombo', stations: [], reward: 'Nothing' },
      { name: 'NullCombo', stations: null, reward: 'Nothing' },
      { name: 'GoodCombo', stations: [1, 2], reward: 'Prize' },
    ];
    const client = createMockClient({ combos });
    const result = await evaluateCombos('tag1', new Set([1, 2, 3]), { client, tableName });
    expect(result).toEqual([
      { comboName: 'GoodCombo', reward: 'Prize', stations: [1, 2] },
    ]);
  });
});
