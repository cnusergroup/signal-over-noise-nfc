import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleProgress } from '../../src/progress-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

/**
 * Creates a mock DynamoDB DocumentClient for progress handler tests.
 */
function createMockClient(options = {}) {
  const {
    checkinItems = [],
    stampRallyRecord = null,
    queryShouldFail = false,
    getShouldFail = false,
  } = options;

  return {
    send: vi.fn(async (command) => {
      const commandName = command.constructor.name;

      if (commandName === 'QueryCommand') {
        if (queryShouldFail) {
          throw new Error('DynamoDB unavailable');
        }
        return { Items: checkinItems };
      }

      if (commandName === 'GetCommand') {
        if (getShouldFail) {
          throw new Error('DynamoDB unavailable');
        }
        // Stamp rally lookup
        const key = command.input?.Key;
        if (key?.SK === 'STAMPRALLY') {
          return { Item: stampRallyRecord };
        }
        return { Item: undefined };
      }

      return {};
    }),
  };
}

describe('progress-handler', () => {
  const FIXED_TIME = 1700000000000; // 2023-11-14T22:13:20.000Z
  const CURRENT_EPOCH_SECONDS = Math.floor(FIXED_TIME / 1000); // 1700000000

  beforeEach(() => {
    setClock(() => FIXED_TIME);
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  describe('input validation', () => {
    it('returns 400 when tagId is empty string', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleProgress('');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('missing_field');
      expect(body.field).toBe('tagId');
    });

    it('returns 400 when tagId is whitespace only', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleProgress('   ');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('missing_field');
      expect(body.field).toBe('tagId');
    });

    it('returns 400 when tagId is null', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleProgress(null);
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('missing_field');
      expect(body.field).toBe('tagId');
    });

    it('returns 400 when tagId is undefined', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleProgress(undefined);
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('missing_field');
      expect(body.field).toBe('tagId');
    });
  });

  describe('no check-ins', () => {
    it('returns empty stations with totalCheckins 0 and completed false', async () => {
      const mockClient = createMockClient({ checkinItems: [] });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.tagId).toBe('tag-abc');
      expect(body.totalCheckins).toBe(0);
      expect(body.completed).toBe(false);
      expect(body.rewardCode).toBeNull();
      expect(body.stations).toEqual([]);
    });
  });

  describe('partial check-ins', () => {
    it('returns stations sorted by stationId ascending', async () => {
      const checkinItems = [
        { stationId: 5, checkinTime: '2023-11-14T20:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS + 86400 },
        { stationId: 2, checkinTime: '2023-11-14T19:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS + 86400 },
        { stationId: 8, checkinTime: '2023-11-14T21:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS + 86400 },
      ];
      const mockClient = createMockClient({ checkinItems });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.totalCheckins).toBe(3);
      expect(body.completed).toBe(false);
      expect(body.rewardCode).toBeNull();
      expect(body.stations).toEqual([
        { stationId: 2, checkinTime: '2023-11-14T19:00:00.000Z' },
        { stationId: 5, checkinTime: '2023-11-14T20:00:00.000Z' },
        { stationId: 8, checkinTime: '2023-11-14T21:00:00.000Z' },
      ]);
    });

    it('returns correct totalCheckins count', async () => {
      const checkinItems = [
        { stationId: 1, checkinTime: '2023-11-14T18:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS + 86400 },
        { stationId: 3, checkinTime: '2023-11-14T19:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS + 86400 },
      ];
      const mockClient = createMockClient({ checkinItems });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      expect(body.totalCheckins).toBe(2);
      expect(body.completed).toBe(false);
    });
  });

  describe('stamp rally complete', () => {
    it('returns completed true and rewardCode when all 10 stations visited', async () => {
      const checkinItems = Array.from({ length: 10 }, (_, i) => ({
        stationId: i + 1,
        checkinTime: `2023-11-14T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
        ttl: CURRENT_EPOCH_SECONDS + 86400,
      }));
      const stampRallyRecord = { rewardCode: 'REWARD-ABC123XYZ456' };
      const mockClient = createMockClient({ checkinItems, stampRallyRecord });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.totalCheckins).toBe(10);
      expect(body.completed).toBe(true);
      expect(body.rewardCode).toBe('REWARD-ABC123XYZ456');
      expect(body.stations).toHaveLength(10);
      // Verify sorted ascending
      for (let i = 0; i < 9; i++) {
        expect(body.stations[i].stationId).toBeLessThan(body.stations[i + 1].stationId);
      }
    });

    it('returns completed true with null rewardCode if stamp rally record not yet created', async () => {
      const checkinItems = Array.from({ length: 10 }, (_, i) => ({
        stationId: i + 1,
        checkinTime: `2023-11-14T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
        ttl: CURRENT_EPOCH_SECONDS + 86400,
      }));
      const mockClient = createMockClient({ checkinItems, stampRallyRecord: null });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      expect(body.completed).toBe(true);
      expect(body.rewardCode).toBeNull();
    });

    it('does not fetch stamp rally record when not all stations visited', async () => {
      const checkinItems = [
        { stationId: 1, checkinTime: '2023-11-14T18:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS + 86400 },
      ];
      const mockClient = createMockClient({ checkinItems });
      setDocClient(mockClient);

      await handleProgress('tag-abc');

      // Should only have the QueryCommand call, no GetCommand for stamp rally
      const getCalls = mockClient.send.mock.calls.filter(
        ([cmd]) => cmd.constructor.name === 'GetCommand'
      );
      expect(getCalls).toHaveLength(0);
    });
  });

  describe('expired record filtering', () => {
    it('excludes records with TTL less than current time', async () => {
      const checkinItems = [
        { stationId: 1, checkinTime: '2023-11-14T18:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS + 86400 }, // valid
        { stationId: 2, checkinTime: '2023-10-01T10:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS - 100 }, // expired
        { stationId: 3, checkinTime: '2023-11-14T19:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS + 86400 }, // valid
      ];
      const mockClient = createMockClient({ checkinItems });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      expect(body.totalCheckins).toBe(2);
      expect(body.stations).toEqual([
        { stationId: 1, checkinTime: '2023-11-14T18:00:00.000Z' },
        { stationId: 3, checkinTime: '2023-11-14T19:00:00.000Z' },
      ]);
    });

    it('keeps records without a TTL field', async () => {
      const checkinItems = [
        { stationId: 1, checkinTime: '2023-11-14T18:00:00.000Z' }, // no ttl field
        { stationId: 2, checkinTime: '2023-11-14T19:00:00.000Z', ttl: CURRENT_EPOCH_SECONDS + 86400 },
      ];
      const mockClient = createMockClient({ checkinItems });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      expect(body.totalCheckins).toBe(2);
    });

    it('completion status reflects only non-expired records', async () => {
      // 10 records but one is expired, so only 9 valid => not complete
      const checkinItems = Array.from({ length: 10 }, (_, i) => ({
        stationId: i + 1,
        checkinTime: `2023-11-14T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
        ttl: i === 5 ? CURRENT_EPOCH_SECONDS - 1 : CURRENT_EPOCH_SECONDS + 86400,
      }));
      const mockClient = createMockClient({ checkinItems });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      expect(body.totalCheckins).toBe(9);
      expect(body.completed).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns 500 when DynamoDB query fails', async () => {
      const mockClient = createMockClient({ queryShouldFail: true });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(500);
      expect(body.error).toBe('internal_error');
    });

    it('returns 200 with null rewardCode when stamp rally GetItem fails', async () => {
      // All 10 stations visited but GetItem for stamp rally fails
      const checkinItems = Array.from({ length: 10 }, (_, i) => ({
        stationId: i + 1,
        checkinTime: `2023-11-14T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
        ttl: CURRENT_EPOCH_SECONDS + 86400,
      }));
      const mockClient = createMockClient({ checkinItems, getShouldFail: true });
      setDocClient(mockClient);

      const res = await handleProgress('tag-abc');
      const body = JSON.parse(res.body);

      // Should still return 200 with null rewardCode (non-fatal error)
      expect(res.statusCode).toBe(200);
      expect(body.completed).toBe(true);
      expect(body.rewardCode).toBeNull();
    });
  });

  describe('DynamoDB query parameters', () => {
    it('queries with correct key condition for tag check-ins', async () => {
      const mockClient = createMockClient({ checkinItems: [] });
      setDocClient(mockClient);

      await handleProgress('tag-xyz');

      const queryCall = mockClient.send.mock.calls.find(
        ([cmd]) => cmd.constructor.name === 'QueryCommand'
      );
      expect(queryCall).toBeDefined();

      const input = queryCall[0].input;
      expect(input.TableName).toBe('TestTable');
      expect(input.KeyConditionExpression).toContain('PK = :pk');
      expect(input.KeyConditionExpression).toContain('begins_with(SK, :skPrefix)');
      expect(input.ExpressionAttributeValues[':pk']).toBe('TAG#tag-xyz');
      expect(input.ExpressionAttributeValues[':skPrefix']).toBe('CHECKIN#');
    });
  });
});
