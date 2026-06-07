import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { evaluateMissions } from '../../src/mission-engine/evaluator.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

/**
 * Creates a mock DynamoDB client for evaluator tests.
 * @param {object} options - Configuration for mock responses
 */
function createMockClient(options = {}) {
  const {
    activeMissions = [],
    queryShouldFail = false,
  } = options;

  return {
    send: vi.fn(async (command) => {
      const commandName = command.constructor.name;

      if (queryShouldFail) {
        throw new Error('DynamoDB unavailable');
      }

      if (commandName === 'QueryCommand') {
        const input = command.input;
        const keyExpr = input.KeyConditionExpression || '';

        // GSI1 query for mission types
        if (keyExpr.includes('GSI1PK')) {
          const pkValue = input.ExpressionAttributeValues?.[':gsiPk'] || '';
          const type = pkValue.replace('MISSION_TYPE#', '');
          const matchingMissions = activeMissions.filter(m => m.type === type);
          return { Items: matchingMissions };
        }

        // Base table queries (for stamp rally, combos, etc.)
        return { Items: [] };
      }

      if (commandName === 'GetCommand') {
        return { Item: undefined };
      }

      if (commandName === 'UpdateCommand') {
        return { Attributes: { visitorCount: 1 } };
      }

      if (commandName === 'PutCommand') {
        return {};
      }

      return {};
    }),
  };
}

describe('mission-engine/evaluator', () => {
  const FIXED_TIME = 1700000000000; // 2023-11-14T22:13:20.000Z

  beforeEach(() => {
    setClock(() => FIXED_TIME);
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  describe('evaluateMissions', () => {
    it('returns default structure when no active missions exist', async () => {
      const mockClient = createMockClient({ activeMissions: [] });
      setDocClient(mockClient);

      const result = await evaluateMissions({
        tagId: 'tag-abc',
        stationId: 3,
        checkinTime: new Date(FIXED_TIME).toISOString(),
        isNewCheckin: true,
      });

      expect(result.numberedVisit).toEqual([]);
      expect(result.earlyBird).toBeNull();
      expect(result.luckyDraw).toBeNull();
      expect(result.lastCall).toBeNull();
      expect(result.comboCompleted).toEqual([]);
      expect(result.stampRally).toEqual({ completed: false, rewardCode: null });
    });

    it('filters missions by stationId', async () => {
      const mockClient = createMockClient({
        activeMissions: [
          {
            PK: 'MISSION#m1',
            SK: 'CONFIG',
            missionId: 'm1',
            type: 'numbered_visit',
            stationId: 5, // different station
            status: 'active',
            startTime: new Date(FIXED_TIME - 60000).toISOString(),
            endTime: new Date(FIXED_TIME + 60000).toISOString(),
          },
        ],
      });
      setDocClient(mockClient);

      const result = await evaluateMissions({
        tagId: 'tag-abc',
        stationId: 3, // station 3, mission is for station 5
        checkinTime: new Date(FIXED_TIME).toISOString(),
        isNewCheckin: true,
      });

      // No numbered visit results since mission is for a different station
      expect(result.numberedVisit).toEqual([]);
    });

    it('filters missions by time window', async () => {
      const mockClient = createMockClient({
        activeMissions: [
          {
            PK: 'MISSION#m1',
            SK: 'CONFIG',
            missionId: 'm1',
            type: 'numbered_visit',
            stationId: 3,
            status: 'active',
            startTime: new Date(FIXED_TIME + 60000).toISOString(), // starts in the future
            endTime: new Date(FIXED_TIME + 120000).toISOString(),
          },
        ],
      });
      setDocClient(mockClient);

      const result = await evaluateMissions({
        tagId: 'tag-abc',
        stationId: 3,
        checkinTime: new Date(FIXED_TIME).toISOString(),
        isNewCheckin: true,
      });

      // No numbered visit results since mission hasn't started yet
      expect(result.numberedVisit).toEqual([]);
    });

    it('filters missions by status (only active/scheduled)', async () => {
      const mockClient = createMockClient({
        activeMissions: [
          {
            PK: 'MISSION#m1',
            SK: 'CONFIG',
            missionId: 'm1',
            type: 'numbered_visit',
            stationId: 3,
            status: 'completed', // not active
            startTime: new Date(FIXED_TIME - 60000).toISOString(),
            endTime: new Date(FIXED_TIME + 60000).toISOString(),
          },
        ],
      });
      setDocClient(mockClient);

      const result = await evaluateMissions({
        tagId: 'tag-abc',
        stationId: 3,
        checkinTime: new Date(FIXED_TIME).toISOString(),
        isNewCheckin: true,
      });

      expect(result.numberedVisit).toEqual([]);
    });

    it('handles graceful degradation when mission processor fails', async () => {
      // Create a mock client that fails on UpdateCommand to simulate a DynamoDB error
      // during mission processing
      const failingMockClient = {
        send: vi.fn(async (command) => {
          const commandName = command.constructor.name;

          if (commandName === 'QueryCommand') {
            const input = command.input;
            const keyExpr = input.KeyConditionExpression || '';
            if (keyExpr.includes('GSI1PK')) {
              const pkValue = input.ExpressionAttributeValues?.[':gsiPk'] || '';
              const type = pkValue.replace('MISSION_TYPE#', '');
              if (type === 'numbered_visit') {
                return {
                  Items: [{
                    PK: 'MISSION#m1',
                    SK: 'CONFIG',
                    missionId: 'm1',
                    type: 'numbered_visit',
                    stationId: 3,
                    status: 'active',
                    startTime: new Date(FIXED_TIME - 60000).toISOString(),
                    endTime: new Date(FIXED_TIME + 60000).toISOString(),
                    milestones: [10],
                  }],
                };
              }
              return { Items: [] };
            }
            return { Items: [] };
          }

          if (commandName === 'GetCommand') {
            return { Item: undefined };
          }

          if (commandName === 'UpdateCommand') {
            // Simulate DynamoDB failure during counter increment
            throw new Error('DynamoDB throttled');
          }

          if (commandName === 'PutCommand') {
            return {};
          }

          return {};
        }),
      };
      setDocClient(failingMockClient);

      const result = await evaluateMissions({
        tagId: 'tag-abc',
        stationId: 3,
        checkinTime: new Date(FIXED_TIME).toISOString(),
        isNewCheckin: true,
      });

      // Should have missionErrors but not crash
      expect(result.missionErrors).toBeDefined();
      expect(result.missionErrors.length).toBeGreaterThan(0);
      const missionError = result.missionErrors.find(e => e.type === 'numbered_visit');
      expect(missionError).toBeDefined();
      expect(missionError.message).toContain('DynamoDB throttled');
    });

    it('handles graceful degradation when query fails', async () => {
      const mockClient = createMockClient({ queryShouldFail: true });
      setDocClient(mockClient);

      const result = await evaluateMissions({
        tagId: 'tag-abc',
        stationId: 3,
        checkinTime: new Date(FIXED_TIME).toISOString(),
        isNewCheckin: true,
      });

      // Should still return a valid structure with errors
      expect(result.numberedVisit).toEqual([]);
      expect(result.missionErrors).toBeDefined();
      expect(result.missionErrors.length).toBeGreaterThan(0);
    });

    it('dispatches multiple mission types correctly', async () => {
      const mockClient = createMockClient({
        activeMissions: [
          {
            PK: 'MISSION#m1',
            SK: 'CONFIG',
            missionId: 'm1',
            type: 'numbered_visit',
            stationId: 3,
            status: 'active',
            startTime: new Date(FIXED_TIME - 60000).toISOString(),
            endTime: new Date(FIXED_TIME + 60000).toISOString(),
            milestones: [10, 50, 100],
          },
          {
            PK: 'MISSION#m2',
            SK: 'CONFIG',
            missionId: 'm2',
            type: 'lucky_draw',
            stationId: 3,
            status: 'active',
            startTime: new Date(FIXED_TIME - 60000).toISOString(),
            endTime: new Date(FIXED_TIME + 60000).toISOString(),
            winnerCount: 5,
          },
        ],
      });
      setDocClient(mockClient);

      const result = await evaluateMissions({
        tagId: 'tag-abc',
        stationId: 3,
        checkinTime: new Date(FIXED_TIME).toISOString(),
        isNewCheckin: true,
      });

      // numbered_visit works and produces a result
      expect(result.numberedVisit.length).toBe(1);
      expect(result.numberedVisit[0].missionId).toBe('m1');
      expect(result.numberedVisit[0].visitorNumber).toBe(1);

      // lucky_draw is implemented and records an entry successfully
      expect(result.luckyDraw).toBeDefined();
      expect(result.luckyDraw.entered).toBe(true);
    });

    it('does not include missionErrors when no errors occur', async () => {
      // With no active missions and stamp-rally/combo implemented,
      // there should be no missionErrors when everything succeeds.
      const mockClient = createMockClient({ activeMissions: [] });
      setDocClient(mockClient);

      const result = await evaluateMissions({
        tagId: 'tag-abc',
        stationId: 3,
        checkinTime: new Date(FIXED_TIME).toISOString(),
        isNewCheckin: true,
      });

      // stamp-rally and combo are now implemented, so no errors should occur
      expect(result.missionErrors).toBeUndefined();
    });

    it('passes isNewCheckin=false during cooldown', async () => {
      const mockClient = createMockClient({ activeMissions: [] });
      setDocClient(mockClient);

      const result = await evaluateMissions({
        tagId: 'tag-abc',
        stationId: 3,
        checkinTime: new Date(FIXED_TIME - 5000).toISOString(),
        isNewCheckin: false,
      });

      // Should still return valid structure
      expect(result.numberedVisit).toEqual([]);
      expect(result.earlyBird).toBeNull();
    });
  });
});
