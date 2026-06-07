import { describe, it, expect, vi } from 'vitest';
import { processNumberedVisit } from '../../src/mission-engine/numbered-visit.mjs';

/**
 * Creates a mock DynamoDB client for numbered-visit tests.
 * @param {object} options - Configuration for mock responses
 */
function createMockClient(options = {}) {
  const {
    existingEntry = null,
    counterValue = 1,
    putShouldFail = false,
    retryEntry = null,
  } = options;

  return {
    send: vi.fn(async (command) => {
      const commandName = command.constructor.name;

      if (commandName === 'GetCommand') {
        const sk = command.input.Key.SK;
        // First GetCommand call checks existing entry
        if (existingEntry && sk === `ENTRY#${existingEntry.tagId}`) {
          return { Item: existingEntry };
        }
        // Retry get after conditional check failure
        if (retryEntry && sk === `ENTRY#${retryEntry.tagId}`) {
          return { Item: retryEntry };
        }
        return { Item: undefined };
      }

      if (commandName === 'UpdateCommand') {
        return {
          Attributes: { visitorCount: counterValue },
        };
      }

      if (commandName === 'PutCommand') {
        if (putShouldFail) {
          const err = new Error('The conditional request failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        return {};
      }

      return {};
    }),
  };
}

describe('mission-engine/numbered-visit', () => {
  const baseMission = {
    missionId: 'mission-1',
    type: 'numbered_visit',
    stationId: 3,
    milestones: [10, 50, 100],
  };

  describe('processNumberedVisit', () => {
    it('assigns visitor number 1 to first visitor', async () => {
      const mockClient = createMockClient({ counterValue: 1 });

      const result = await processNumberedVisit(baseMission, 'tag-001', {
        client: mockClient,
        tableName: 'TestTable',
      });

      expect(result.missionId).toBe('mission-1');
      expect(result.visitorNumber).toBe(1);
      expect(result.isMilestone).toBe(false);
      expect(result.milestoneMessage).toBeNull();
    });

    it('returns existing visitor number for repeat visitor (idempotency)', async () => {
      const mockClient = createMockClient({
        existingEntry: {
          PK: 'MISSION#mission-1',
          SK: 'ENTRY#tag-001',
          visitorNumber: 7,
          tagId: 'tag-001',
          missionId: 'mission-1',
        },
      });

      const result = await processNumberedVisit(baseMission, 'tag-001', {
        client: mockClient,
        tableName: 'TestTable',
      });

      expect(result.visitorNumber).toBe(7);
      expect(result.isMilestone).toBe(false);
      expect(result.milestoneMessage).toBeNull();
      // Should not have called UpdateCommand (no counter increment)
      const updateCalls = mockClient.send.mock.calls.filter(
        ([cmd]) => cmd.constructor.name === 'UpdateCommand'
      );
      expect(updateCalls).toHaveLength(0);
    });

    it('detects milestone when visitor number matches', async () => {
      const mockClient = createMockClient({ counterValue: 10 });

      const result = await processNumberedVisit(baseMission, 'tag-010', {
        client: mockClient,
        tableName: 'TestTable',
      });

      expect(result.visitorNumber).toBe(10);
      expect(result.isMilestone).toBe(true);
      expect(result.milestoneMessage).toBe('You are visitor #10!');
    });

    it('detects milestone for existing visitor on repeat check-in', async () => {
      const mockClient = createMockClient({
        existingEntry: {
          PK: 'MISSION#mission-1',
          SK: 'ENTRY#tag-050',
          visitorNumber: 50,
          tagId: 'tag-050',
          missionId: 'mission-1',
        },
      });

      const result = await processNumberedVisit(baseMission, 'tag-050', {
        client: mockClient,
        tableName: 'TestTable',
      });

      expect(result.visitorNumber).toBe(50);
      expect(result.isMilestone).toBe(true);
      expect(result.milestoneMessage).toBe('You are visitor #50!');
    });

    it('does not flag non-milestone numbers', async () => {
      const mockClient = createMockClient({ counterValue: 42 });

      const result = await processNumberedVisit(baseMission, 'tag-042', {
        client: mockClient,
        tableName: 'TestTable',
      });

      expect(result.visitorNumber).toBe(42);
      expect(result.isMilestone).toBe(false);
      expect(result.milestoneMessage).toBeNull();
    });

    it('handles concurrent access via conditional write failure', async () => {
      // Simulate: another request wrote the entry between our counter increment and PutItem
      const mockClient = createMockClient({
        putShouldFail: true,
        counterValue: 5,
      });

      // Override the send to return the retry entry on second GetCommand call
      let getCallCount = 0;
      mockClient.send = vi.fn(async (command) => {
        const commandName = command.constructor.name;

        if (commandName === 'GetCommand') {
          getCallCount++;
          if (getCallCount === 1) {
            // First get: no existing entry
            return { Item: undefined };
          }
          // Second get (retry after conditional failure): entry exists
          return {
            Item: {
              PK: 'MISSION#mission-1',
              SK: 'ENTRY#tag-race',
              visitorNumber: 3,
              tagId: 'tag-race',
              missionId: 'mission-1',
            },
          };
        }

        if (commandName === 'UpdateCommand') {
          return { Attributes: { visitorCount: 5 } };
        }

        if (commandName === 'PutCommand') {
          const err = new Error('The conditional request failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }

        return {};
      });

      const result = await processNumberedVisit(baseMission, 'tag-race', {
        client: mockClient,
        tableName: 'TestTable',
      });

      // Should return the entry that won the race (visitorNumber 3)
      expect(result.visitorNumber).toBe(3);
      expect(result.missionId).toBe('mission-1');
    });

    it('extracts missionId from PK when missionId field is absent', async () => {
      const missionWithPK = {
        PK: 'MISSION#m-from-pk',
        type: 'numbered_visit',
        stationId: 3,
        milestones: [5],
      };
      const mockClient = createMockClient({ counterValue: 5 });

      const result = await processNumberedVisit(missionWithPK, 'tag-pk', {
        client: mockClient,
        tableName: 'TestTable',
      });

      expect(result.missionId).toBe('m-from-pk');
      expect(result.visitorNumber).toBe(5);
      expect(result.isMilestone).toBe(true);
    });

    it('handles mission with empty milestones array', async () => {
      const missionNoMilestones = {
        missionId: 'mission-no-ms',
        type: 'numbered_visit',
        stationId: 1,
        milestones: [],
      };
      const mockClient = createMockClient({ counterValue: 1 });

      const result = await processNumberedVisit(missionNoMilestones, 'tag-noms', {
        client: mockClient,
        tableName: 'TestTable',
      });

      expect(result.visitorNumber).toBe(1);
      expect(result.isMilestone).toBe(false);
      expect(result.milestoneMessage).toBeNull();
    });

    it('handles mission with no milestones field (undefined)', async () => {
      const missionUndefinedMs = {
        missionId: 'mission-undef',
        type: 'numbered_visit',
        stationId: 1,
      };
      const mockClient = createMockClient({ counterValue: 3 });

      const result = await processNumberedVisit(missionUndefinedMs, 'tag-undef', {
        client: mockClient,
        tableName: 'TestTable',
      });

      expect(result.visitorNumber).toBe(3);
      expect(result.isMilestone).toBe(false);
      expect(result.milestoneMessage).toBeNull();
    });

    it('writes correct DynamoDB item with GSI keys', async () => {
      const mockClient = createMockClient({ counterValue: 2 });

      await processNumberedVisit(baseMission, 'tag-gsi', {
        client: mockClient,
        tableName: 'TestTable',
      });

      // Find the PutCommand call
      const putCall = mockClient.send.mock.calls.find(
        ([cmd]) => cmd.constructor.name === 'PutCommand'
      );
      expect(putCall).toBeDefined();

      const putInput = putCall[0].input;
      expect(putInput.TableName).toBe('TestTable');
      expect(putInput.Item.PK).toBe('MISSION#mission-1');
      expect(putInput.Item.SK).toBe('ENTRY#tag-gsi');
      expect(putInput.Item.visitorNumber).toBe(2);
      expect(putInput.Item.tagId).toBe('tag-gsi');
      expect(putInput.Item.missionId).toBe('mission-1');
      expect(putInput.Item.GSI1PK).toBe('TAG#tag-gsi');
      expect(putInput.Item.GSI1SK).toBe('MISSION#mission-1');
      expect(putInput.ConditionExpression).toBe('attribute_not_exists(PK)');
    });

    it('uses ADD expression for atomic counter increment', async () => {
      const mockClient = createMockClient({ counterValue: 1 });

      await processNumberedVisit(baseMission, 'tag-add', {
        client: mockClient,
        tableName: 'TestTable',
      });

      // Find the UpdateCommand call
      const updateCall = mockClient.send.mock.calls.find(
        ([cmd]) => cmd.constructor.name === 'UpdateCommand'
      );
      expect(updateCall).toBeDefined();

      const updateInput = updateCall[0].input;
      expect(updateInput.Key.PK).toBe('MISSION#mission-1');
      expect(updateInput.Key.SK).toBe('COUNTER');
      expect(updateInput.UpdateExpression).toBe('ADD visitorCount :inc');
      expect(updateInput.ExpressionAttributeValues[':inc']).toBe(1);
      expect(updateInput.ReturnValues).toBe('ALL_NEW');
    });

    it('re-throws non-conditional-check errors from PutCommand', async () => {
      const mockClient = createMockClient({ counterValue: 1 });
      mockClient.send = vi.fn(async (command) => {
        const commandName = command.constructor.name;
        if (commandName === 'GetCommand') return { Item: undefined };
        if (commandName === 'UpdateCommand') return { Attributes: { visitorCount: 1 } };
        if (commandName === 'PutCommand') {
          throw new Error('InternalServerError');
        }
        return {};
      });

      await expect(
        processNumberedVisit(baseMission, 'tag-err', {
          client: mockClient,
          tableName: 'TestTable',
        })
      ).rejects.toThrow('InternalServerError');
    });
  });
});
