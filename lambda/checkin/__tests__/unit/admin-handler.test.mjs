import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleMissionAdmin, setSchedulerClient } from '../../src/admin-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

const FIXED_TIME = 1700000000000; // 2023-11-14T22:13:20.000Z
const FUTURE_START = '2023-11-15T10:00:00.000Z'; // after FIXED_TIME
const FUTURE_END = '2023-11-15T18:00:00.000Z';
const PAST_START = '2023-11-13T10:00:00.000Z'; // before FIXED_TIME
const PAST_END = '2023-11-13T18:00:00.000Z';

/**
 * Creates a mock DynamoDB DocumentClient for admin handler tests.
 */
function createMockClient(options = {}) {
  const {
    missions = [],
    missionItem = null,
    winners = [],
    putShouldFail = false,
    getShouldFail = false,
    updateResult = null,
  } = options;

  return {
    send: vi.fn(async (command) => {
      const commandName = command.constructor.name;

      if (getShouldFail) {
        throw new Error('DynamoDB unavailable');
      }

      if (commandName === 'GetCommand') {
        const key = command.input?.Key;
        if (key?.SK === 'CONFIG' && missionItem) {
          return { Item: missionItem };
        }
        return { Item: undefined };
      }

      if (commandName === 'PutCommand') {
        if (putShouldFail) {
          throw new Error('DynamoDB write failed');
        }
        return {};
      }

      if (commandName === 'QueryCommand') {
        const expr = command.input?.KeyConditionExpression || '';
        // Winner query (uses begins_with on SK)
        if (expr.includes('begins_with(SK, :skPrefix)')) {
          return { Items: winners };
        }
        // GSI1 mission list query
        return { Items: missions };
      }

      if (commandName === 'UpdateCommand') {
        return { Attributes: updateResult || {} };
      }

      if (commandName === 'DeleteCommand') {
        return {};
      }

      return {};
    }),
  };
}

function createMockSchedulerClient() {
  return {
    send: vi.fn(async () => ({})),
  };
}

describe('admin-handler', () => {
  beforeEach(() => {
    setClock(() => FIXED_TIME);
    process.env.TABLE_NAME = 'TestTable';
    process.env.LUCKY_DRAW_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789:function:lucky-draw';
    process.env.LAST_CALL_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789:function:last-call';
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789:role/scheduler-role';
    setSchedulerClient(createMockSchedulerClient());
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    setSchedulerClient(null);
    delete process.env.TABLE_NAME;
    delete process.env.LUCKY_DRAW_LAMBDA_ARN;
    delete process.env.LAST_CALL_LAMBDA_ARN;
    delete process.env.SCHEDULER_ROLE_ARN;
  });

  describe('POST /missions — create mission', () => {
    it('creates a numbered_visit mission and returns 201', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const body = {
        type: 'numbered_visit',
        name: 'Test Mission',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 5,
        milestones: [10, 50, 100],
      };

      const res = await handleMissionAdmin({ method: 'POST', body });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(201);
      expect(resBody.missionId).toBeDefined();
      expect(resBody.type).toBe('numbered_visit');
      expect(resBody.name).toBe('Test Mission');
      expect(resBody.startTime).toBe(FUTURE_START);
      expect(resBody.endTime).toBe(FUTURE_END);
      expect(resBody.status).toBe('scheduled');
      expect(resBody.stationId).toBe(5);
      expect(resBody.milestones).toEqual([10, 50, 100]);
    });

    it('creates counter record for numbered_visit mission', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const body = {
        type: 'numbered_visit',
        name: 'Counter Test',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 3,
        milestones: [10],
      };

      await handleMissionAdmin({ method: 'POST', body });

      // Find PutCommand calls
      const putCalls = mockClient.send.mock.calls.filter(
        ([cmd]) => cmd.constructor.name === 'PutCommand'
      );

      // Should have 2 PutCommands: config + counter
      expect(putCalls.length).toBe(2);

      const counterPut = putCalls.find(([cmd]) => cmd.input.Item.SK === 'COUNTER');
      expect(counterPut).toBeDefined();
      expect(counterPut[0].input.Item.visitorCount).toBe(0);
    });

    it('creates a lucky_draw mission and schedules EventBridge', async () => {
      const mockClient = createMockClient();
      const mockScheduler = createMockSchedulerClient();
      setDocClient(mockClient);
      setSchedulerClient(mockScheduler);

      const body = {
        type: 'lucky_draw',
        name: 'Lucky Draw Test',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 2,
        winnerCount: 5,
        prizeDescription: 'A cool prize',
      };

      const res = await handleMissionAdmin({ method: 'POST', body });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(201);
      expect(resBody.type).toBe('lucky_draw');
      expect(resBody.winnerCount).toBe(5);

      // Verify scheduler was called
      expect(mockScheduler.send).toHaveBeenCalledTimes(1);
      const scheduleCmd = mockScheduler.send.mock.calls[0][0];
      expect(scheduleCmd.input.Name).toContain('mission-');
      expect(scheduleCmd.input.Name).toContain('-end');
      expect(scheduleCmd.input.Target.Arn).toBe(process.env.LUCKY_DRAW_LAMBDA_ARN);
    });

    it('creates a last_call mission and schedules EventBridge', async () => {
      const mockClient = createMockClient();
      const mockScheduler = createMockSchedulerClient();
      setDocClient(mockClient);
      setSchedulerClient(mockScheduler);

      const body = {
        type: 'last_call',
        name: 'Last Call Test',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 7,
        winnerCount: 3,
        bonusPoints: 50,
      };

      const res = await handleMissionAdmin({ method: 'POST', body });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(201);
      expect(resBody.type).toBe('last_call');

      // Verify scheduler was called with last call lambda
      expect(mockScheduler.send).toHaveBeenCalledTimes(1);
      const scheduleCmd = mockScheduler.send.mock.calls[0][0];
      expect(scheduleCmd.input.Target.Arn).toBe(process.env.LAST_CALL_LAMBDA_ARN);
    });

    it('creates an early_bird mission without scheduling EventBridge', async () => {
      const mockClient = createMockClient();
      const mockScheduler = createMockSchedulerClient();
      setDocClient(mockClient);
      setSchedulerClient(mockScheduler);

      const body = {
        type: 'early_bird',
        name: 'Early Bird Test',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 1,
        winnerCount: 10,
        bonusPoints: 25,
      };

      const res = await handleMissionAdmin({ method: 'POST', body });
      expect(res.statusCode).toBe(201);

      // Scheduler should NOT be called for early_bird
      expect(mockScheduler.send).not.toHaveBeenCalled();
    });

    it('sets correct TTL on mission record', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const body = {
        type: 'numbered_visit',
        name: 'TTL Test',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 1,
        milestones: [5],
      };

      await handleMissionAdmin({ method: 'POST', body });

      const putCall = mockClient.send.mock.calls.find(
        ([cmd]) => cmd.constructor.name === 'PutCommand' && cmd.input.Item.SK === 'CONFIG'
      );

      const endTimeMs = new Date(FUTURE_END).getTime();
      const expectedTTL = Math.floor(endTimeMs / 1000) + 30 * 24 * 60 * 60;
      expect(putCall[0].input.Item.ttl).toBe(expectedTTL);
    });

    it('sets GSI1PK and GSI1SK correctly', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const body = {
        type: 'lucky_draw',
        name: 'GSI Test',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 4,
        winnerCount: 2,
      };

      await handleMissionAdmin({ method: 'POST', body });

      const putCall = mockClient.send.mock.calls.find(
        ([cmd]) => cmd.constructor.name === 'PutCommand' && cmd.input.Item.SK === 'CONFIG'
      );

      expect(putCall[0].input.Item.GSI1PK).toBe('MISSION_TYPE#lucky_draw');
      expect(putCall[0].input.Item.GSI1SK).toBe(FUTURE_START);
    });

    it('generates a uuid for missionId', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const body = {
        type: 'numbered_visit',
        name: 'UUID Test',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 1,
        milestones: [10],
      };

      const res = await handleMissionAdmin({ method: 'POST', body });
      const resBody = JSON.parse(res.body);

      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(resBody.missionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('GET /missions — list missions', () => {
    it('returns list of all missions with computed status', async () => {
      const missions = [
        {
          missionId: 'mission-1',
          name: 'Future Mission',
          type: 'numbered_visit',
          startTime: FUTURE_START,
          endTime: FUTURE_END,
        },
        {
          missionId: 'mission-2',
          name: 'Past Mission',
          type: 'lucky_draw',
          startTime: PAST_START,
          endTime: PAST_END,
        },
      ];

      const mockClient = createMockClient({ missions });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({ method: 'GET', action: 'list' });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(resBody.missions).toBeDefined();
      expect(Array.isArray(resBody.missions)).toBe(true);

      // Check that status is computed correctly
      const futureMission = resBody.missions.find(m => m.missionId === 'mission-1');
      const pastMission = resBody.missions.find(m => m.missionId === 'mission-2');

      if (futureMission) expect(futureMission.status).toBe('scheduled');
      if (pastMission) expect(pastMission.status).toBe('completed');
    });

    it('returns empty list when no missions exist', async () => {
      const mockClient = createMockClient({ missions: [] });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({ method: 'GET', action: 'list' });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(resBody.missions).toEqual([]);
    });
  });

  describe('GET /missions/{missionId} — get single mission', () => {
    it('returns full mission config with computed status', async () => {
      const missionItem = {
        PK: 'MISSION#mission-123',
        SK: 'CONFIG',
        missionId: 'mission-123',
        type: 'numbered_visit',
        name: 'Test Mission',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 5,
        milestones: [10, 50, 100],
        createdAt: '2023-11-14T20:00:00.000Z',
      };

      const mockClient = createMockClient({ missionItem });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({ method: 'GET', missionId: 'mission-123', action: 'get' });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(resBody.missionId).toBe('mission-123');
      expect(resBody.type).toBe('numbered_visit');
      expect(resBody.name).toBe('Test Mission');
      expect(resBody.status).toBe('scheduled');
      expect(resBody.stationId).toBe(5);
      expect(resBody.milestones).toEqual([10, 50, 100]);
    });

    it('returns 404 for non-existent mission', async () => {
      const mockClient = createMockClient({ missionItem: null });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({ method: 'GET', missionId: 'nonexistent', action: 'get' });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(404);
      expect(resBody.error).toBe('not_found');
    });

    it('computes active status for currently running mission', async () => {
      const missionItem = {
        PK: 'MISSION#mission-active',
        SK: 'CONFIG',
        missionId: 'mission-active',
        type: 'lucky_draw',
        name: 'Active Mission',
        startTime: PAST_START,
        endTime: FUTURE_END, // started in past, ends in future
        stationId: 2,
        winnerCount: 5,
        createdAt: '2023-11-12T20:00:00.000Z',
      };

      const mockClient = createMockClient({ missionItem });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({ method: 'GET', missionId: 'mission-active', action: 'get' });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(resBody.status).toBe('active');
    });
  });

  describe('PUT /missions/{missionId} — update mission', () => {
    it('updates a scheduled mission successfully', async () => {
      const missionItem = {
        PK: 'MISSION#mission-123',
        SK: 'CONFIG',
        missionId: 'mission-123',
        type: 'numbered_visit',
        name: 'Original Name',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 5,
        milestones: [10, 50],
        createdAt: '2023-11-14T20:00:00.000Z',
      };

      // Mock that returns the item on first GET (check status), then updated item on second GET (return result)
      let getCallCount = 0;
      const mockClient = {
        send: vi.fn(async (command) => {
          const commandName = command.constructor.name;
          if (commandName === 'GetCommand') {
            getCallCount++;
            if (getCallCount === 1) {
              return { Item: missionItem };
            }
            // Return updated item
            return { Item: { ...missionItem, name: 'Updated Name' } };
          }
          if (commandName === 'UpdateCommand') {
            return {};
          }
          return {};
        }),
      };
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'PUT',
        missionId: 'mission-123',
        body: { name: 'Updated Name' },
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(resBody.name).toBe('Updated Name');
    });

    it('returns 409 when mission is active', async () => {
      // Mission that started in the past but hasn't ended
      const activeMission = {
        PK: 'MISSION#mission-active',
        SK: 'CONFIG',
        missionId: 'mission-active',
        type: 'numbered_visit',
        name: 'Active Mission',
        startTime: PAST_START,
        endTime: FUTURE_END, // still running
        stationId: 3,
        milestones: [10],
      };

      const mockClient = createMockClient({ missionItem: activeMission });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'PUT',
        missionId: 'mission-active',
        body: { name: 'New Name' },
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(409);
      expect(resBody.error).toBe('conflict');
    });

    it('returns 409 when mission has ended', async () => {
      const endedMission = {
        PK: 'MISSION#mission-ended',
        SK: 'CONFIG',
        missionId: 'mission-ended',
        type: 'lucky_draw',
        name: 'Ended Mission',
        startTime: PAST_START,
        endTime: PAST_END,
        stationId: 2,
        winnerCount: 5,
      };

      const mockClient = createMockClient({ missionItem: endedMission });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'PUT',
        missionId: 'mission-ended',
        body: { name: 'New Name' },
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(409);
      expect(resBody.error).toBe('conflict');
    });

    it('returns 404 for non-existent mission', async () => {
      const mockClient = createMockClient({ missionItem: null });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'PUT',
        missionId: 'nonexistent',
        body: { name: 'New Name' },
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(404);
      expect(resBody.error).toBe('not_found');
    });
  });

  describe('DELETE /missions/{missionId} — delete mission', () => {
    it('deletes a scheduled mission and returns 204', async () => {
      const missionItem = {
        PK: 'MISSION#mission-123',
        SK: 'CONFIG',
        missionId: 'mission-123',
        type: 'numbered_visit',
        name: 'To Delete',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 5,
        milestones: [10],
      };

      const mockClient = createMockClient({ missionItem });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'DELETE',
        missionId: 'mission-123',
        action: 'delete',
      });

      expect(res.statusCode).toBe(204);
    });

    it('deletes counter record for numbered_visit mission', async () => {
      const missionItem = {
        PK: 'MISSION#mission-123',
        SK: 'CONFIG',
        missionId: 'mission-123',
        type: 'numbered_visit',
        name: 'Numbered Visit',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 5,
        milestones: [10],
      };

      const mockClient = createMockClient({ missionItem });
      setDocClient(mockClient);

      await handleMissionAdmin({
        method: 'DELETE',
        missionId: 'mission-123',
        action: 'delete',
      });

      // Should have 2 DeleteCommand calls: config + counter
      const deleteCalls = mockClient.send.mock.calls.filter(
        ([cmd]) => cmd.constructor.name === 'DeleteCommand'
      );
      expect(deleteCalls.length).toBe(2);
    });

    it('deletes scheduled event for lucky_draw mission', async () => {
      const missionItem = {
        PK: 'MISSION#mission-draw',
        SK: 'CONFIG',
        missionId: 'mission-draw',
        type: 'lucky_draw',
        name: 'Lucky Draw',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 2,
        winnerCount: 5,
      };

      const mockClient = createMockClient({ missionItem });
      const mockScheduler = createMockSchedulerClient();
      setDocClient(mockClient);
      setSchedulerClient(mockScheduler);

      await handleMissionAdmin({
        method: 'DELETE',
        missionId: 'mission-draw',
        action: 'delete',
      });

      // Scheduler should be called to delete the schedule
      expect(mockScheduler.send).toHaveBeenCalledTimes(1);
    });

    it('returns 409 when mission is active', async () => {
      const activeMission = {
        PK: 'MISSION#mission-active',
        SK: 'CONFIG',
        missionId: 'mission-active',
        type: 'numbered_visit',
        name: 'Active Mission',
        startTime: PAST_START,
        endTime: FUTURE_END,
        stationId: 3,
        milestones: [10],
      };

      const mockClient = createMockClient({ missionItem: activeMission });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'DELETE',
        missionId: 'mission-active',
        action: 'delete',
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(409);
      expect(resBody.error).toBe('conflict');
    });

    it('returns 409 when mission has ended', async () => {
      const endedMission = {
        PK: 'MISSION#mission-ended',
        SK: 'CONFIG',
        missionId: 'mission-ended',
        type: 'lucky_draw',
        name: 'Ended Mission',
        startTime: PAST_START,
        endTime: PAST_END,
        stationId: 2,
        winnerCount: 5,
      };

      const mockClient = createMockClient({ missionItem: endedMission });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'DELETE',
        missionId: 'mission-ended',
        action: 'delete',
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(409);
      expect(resBody.error).toBe('conflict');
    });

    it('returns 404 for non-existent mission', async () => {
      const mockClient = createMockClient({ missionItem: null });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'DELETE',
        missionId: 'nonexistent',
        action: 'delete',
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(404);
      expect(resBody.error).toBe('not_found');
    });
  });

  describe('GET /missions/{missionId}/winners — get winners', () => {
    it('returns winner list for existing mission', async () => {
      const missionItem = {
        PK: 'MISSION#mission-123',
        SK: 'CONFIG',
        missionId: 'mission-123',
        type: 'lucky_draw',
        name: 'Lucky Draw',
        startTime: PAST_START,
        endTime: PAST_END,
        stationId: 2,
        winnerCount: 3,
      };

      const winners = [
        { PK: 'MISSION#mission-123', SK: 'WINNER#tag-1', tagId: 'tag-1', wonAt: '2023-11-13T17:00:00.000Z' },
        { PK: 'MISSION#mission-123', SK: 'WINNER#tag-2', tagId: 'tag-2', wonAt: '2023-11-13T17:00:00.000Z' },
      ];

      const mockClient = createMockClient({ missionItem, winners });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'GET',
        missionId: 'mission-123',
        action: 'winners',
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(resBody.missionId).toBe('mission-123');
      expect(resBody.missionName).toBe('Lucky Draw');
      expect(resBody.winners).toHaveLength(2);
      expect(resBody.totalWinners).toBe(2);
      expect(resBody.winners[0].tagId).toBe('tag-1');
    });

    it('returns empty winner list when no winners', async () => {
      const missionItem = {
        PK: 'MISSION#mission-123',
        SK: 'CONFIG',
        missionId: 'mission-123',
        type: 'lucky_draw',
        name: 'Lucky Draw',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 2,
        winnerCount: 3,
      };

      const mockClient = createMockClient({ missionItem, winners: [] });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'GET',
        missionId: 'mission-123',
        action: 'winners',
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(resBody.winners).toEqual([]);
      expect(resBody.totalWinners).toBe(0);
    });

    it('returns 404 for non-existent mission', async () => {
      const mockClient = createMockClient({ missionItem: null });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({
        method: 'GET',
        missionId: 'nonexistent',
        action: 'winners',
      });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(404);
      expect(resBody.error).toBe('not_found');
    });
  });

  describe('error handling', () => {
    it('returns 500 when DynamoDB fails on create', async () => {
      const mockClient = createMockClient({ putShouldFail: true });
      setDocClient(mockClient);

      const body = {
        type: 'numbered_visit',
        name: 'Fail Test',
        startTime: FUTURE_START,
        endTime: FUTURE_END,
        stationId: 1,
        milestones: [10],
      };

      const res = await handleMissionAdmin({ method: 'POST', body });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(500);
      expect(resBody.error).toBe('internal_error');
    });

    it('returns 500 when DynamoDB fails on get', async () => {
      const mockClient = createMockClient({ getShouldFail: true });
      setDocClient(mockClient);

      const res = await handleMissionAdmin({ method: 'GET', missionId: 'mission-123', action: 'get' });
      const resBody = JSON.parse(res.body);

      expect(res.statusCode).toBe(500);
      expect(resBody.error).toBe('internal_error');
    });
  });
});
