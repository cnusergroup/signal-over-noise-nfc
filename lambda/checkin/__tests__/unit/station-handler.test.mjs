import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleStationTraffic, handleStationSummary } from '../../src/station-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

/**
 * Creates a mock DynamoDB DocumentClient for station queries.
 * @param {object} options - Configuration for mock responses
 */
function createMockClient(options = {}) {
  const {
    stationRecords = {},  // { stationId: [records] }
    shouldFail = false,
  } = options;

  return {
    send: vi.fn(async (command) => {
      if (shouldFail) {
        throw new Error('DynamoDB unavailable');
      }

      const commandName = command.constructor.name;
      if (commandName === 'QueryCommand') {
        // Extract stationId from the GSI1PK expression value
        const gsiPk = command.input.ExpressionAttributeValues?.[':gsiPk'];
        if (gsiPk && gsiPk.startsWith('STATION#')) {
          const stationId = parseInt(gsiPk.replace('STATION#', ''), 10);
          const records = stationRecords[stationId] || [];
          return { Items: records };
        }
        return { Items: [] };
      }

      return { Items: [] };
    }),
  };
}

/**
 * Helper to create a check-in record for testing.
 */
function makeRecord(tagId, stationId, checkinTime, ttl = 9999999999) {
  return {
    PK: `TAG#${tagId}`,
    SK: `CHECKIN#${stationId}`,
    GSI1PK: `STATION#${stationId}`,
    GSI1SK: `CHECKIN#${checkinTime}`,
    tagId,
    stationId,
    checkinTime,
    ttl,
  };
}

describe('station-handler', () => {
  const FIXED_TIME = 1700000000000; // 2023-11-14T22:13:20.000Z
  const FIXED_SECONDS = Math.floor(FIXED_TIME / 1000);

  beforeEach(() => {
    setClock(() => FIXED_TIME);
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  describe('handleStationTraffic', () => {
    describe('input validation', () => {
      it('returns 400 for stationId = 0', async () => {
        const mockClient = createMockClient();
        setDocClient(mockClient);

        const res = await handleStationTraffic(0);
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(400);
        expect(body.error).toBe('invalid_field');
        expect(body.field).toBe('stationId');
        // Should NOT have queried DynamoDB
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it('returns 400 for stationId = 11', async () => {
        const mockClient = createMockClient();
        setDocClient(mockClient);

        const res = await handleStationTraffic(11);
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(400);
        expect(body.error).toBe('invalid_field');
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it('returns 400 for non-integer stationId (3.5)', async () => {
        const mockClient = createMockClient();
        setDocClient(mockClient);

        const res = await handleStationTraffic(3.5);
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(400);
        expect(body.error).toBe('invalid_field');
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it('returns 400 for string "abc"', async () => {
        const mockClient = createMockClient();
        setDocClient(mockClient);

        const res = await handleStationTraffic('abc');
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(400);
        expect(body.error).toBe('invalid_field');
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it('returns 400 for negative stationId', async () => {
        const mockClient = createMockClient();
        setDocClient(mockClient);

        const res = await handleStationTraffic(-1);
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(400);
        expect(body.error).toBe('invalid_field');
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it('accepts valid string "5" as stationId', async () => {
        const mockClient = createMockClient({ stationRecords: { 5: [] } });
        setDocClient(mockClient);

        const res = await handleStationTraffic('5');
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(200);
        expect(body.stationId).toBe(5);
      });
    });

    describe('successful queries', () => {
      it('returns empty results for station with no records', async () => {
        const mockClient = createMockClient({ stationRecords: { 1: [] } });
        setDocClient(mockClient);

        const res = await handleStationTraffic(1);
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(200);
        expect(body.stationId).toBe(1);
        expect(body.uniqueVisitors).toBe(0);
        expect(body.recentCheckins).toEqual([]);
      });

      it('returns correct unique visitor count with duplicate tags', async () => {
        const records = [
          makeRecord('tag-a', 2, '2023-11-14T22:00:00.000Z'),
          makeRecord('tag-b', 2, '2023-11-14T21:50:00.000Z'),
          makeRecord('tag-a', 2, '2023-11-14T21:40:00.000Z'), // duplicate tag-a
          makeRecord('tag-c', 2, '2023-11-14T21:30:00.000Z'),
        ];
        const mockClient = createMockClient({ stationRecords: { 2: records } });
        setDocClient(mockClient);

        const res = await handleStationTraffic(2);
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(200);
        expect(body.uniqueVisitors).toBe(3); // tag-a, tag-b, tag-c
        expect(body.recentCheckins).toHaveLength(4); // All timestamps returned
      });

      it('returns timestamps in descending order (as returned by query)', async () => {
        const records = [
          makeRecord('tag-a', 1, '2023-11-14T22:00:00.000Z'),
          makeRecord('tag-b', 1, '2023-11-14T21:00:00.000Z'),
          makeRecord('tag-c', 1, '2023-11-14T20:00:00.000Z'),
        ];
        const mockClient = createMockClient({ stationRecords: { 1: records } });
        setDocClient(mockClient);

        const res = await handleStationTraffic(1);
        const body = JSON.parse(res.body);

        expect(body.recentCheckins).toEqual([
          '2023-11-14T22:00:00.000Z',
          '2023-11-14T21:00:00.000Z',
          '2023-11-14T20:00:00.000Z',
        ]);
      });

      it('limits results to 1000 timestamps', async () => {
        // Create 1200 records
        const records = Array.from({ length: 1200 }, (_, i) => {
          const time = new Date(FIXED_TIME - i * 1000).toISOString();
          return makeRecord(`tag-${i}`, 3, time);
        });
        const mockClient = createMockClient({ stationRecords: { 3: records } });
        setDocClient(mockClient);

        const res = await handleStationTraffic(3);
        const body = JSON.parse(res.body);

        expect(body.recentCheckins).toHaveLength(1000);
        expect(body.uniqueVisitors).toBe(1200); // All unique visitors counted
      });
    });

    describe('TTL filtering', () => {
      it('excludes expired records (TTL < current time)', async () => {
        const records = [
          makeRecord('tag-a', 1, '2023-11-14T22:00:00.000Z', FIXED_SECONDS + 1000), // valid
          makeRecord('tag-b', 1, '2023-11-14T21:00:00.000Z', FIXED_SECONDS - 1),    // expired
          makeRecord('tag-c', 1, '2023-11-14T20:00:00.000Z', FIXED_SECONDS + 500),  // valid
        ];
        const mockClient = createMockClient({ stationRecords: { 1: records } });
        setDocClient(mockClient);

        const res = await handleStationTraffic(1);
        const body = JSON.parse(res.body);

        expect(body.uniqueVisitors).toBe(2); // tag-a and tag-c
        expect(body.recentCheckins).toHaveLength(2);
        expect(body.recentCheckins).not.toContain('2023-11-14T21:00:00.000Z');
      });

      it('keeps records without TTL field', async () => {
        const records = [
          { PK: 'TAG#tag-a', SK: 'CHECKIN#1', GSI1PK: 'STATION#1', tagId: 'tag-a', stationId: 1, checkinTime: '2023-11-14T22:00:00.000Z' },
        ];
        const mockClient = createMockClient({ stationRecords: { 1: records } });
        setDocClient(mockClient);

        const res = await handleStationTraffic(1);
        const body = JSON.parse(res.body);

        expect(body.uniqueVisitors).toBe(1);
        expect(body.recentCheckins).toHaveLength(1);
      });
    });

    describe('error handling', () => {
      it('returns 500 when DynamoDB query fails', async () => {
        const mockClient = createMockClient({ shouldFail: true });
        setDocClient(mockClient);

        const res = await handleStationTraffic(1);
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(500);
        expect(body.error).toBe('internal_error');
      });
    });
  });

  describe('handleStationSummary', () => {
    it('returns all 10 stations with zero visitors when empty', async () => {
      const mockClient = createMockClient({ stationRecords: {} });
      setDocClient(mockClient);

      const res = await handleStationSummary();
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.stations).toHaveLength(10);
      body.stations.forEach((station, idx) => {
        expect(station.stationId).toBe(idx + 1);
        expect(station.uniqueVisitors).toBe(0);
      });
    });

    it('returns correct unique visitor counts per station', async () => {
      const stationRecords = {
        1: [
          makeRecord('tag-a', 1, '2023-11-14T22:00:00.000Z'),
          makeRecord('tag-b', 1, '2023-11-14T21:00:00.000Z'),
        ],
        3: [
          makeRecord('tag-a', 3, '2023-11-14T22:00:00.000Z'),
          makeRecord('tag-c', 3, '2023-11-14T21:00:00.000Z'),
          makeRecord('tag-d', 3, '2023-11-14T20:00:00.000Z'),
        ],
        7: [
          makeRecord('tag-a', 7, '2023-11-14T22:00:00.000Z'),
        ],
      };
      const mockClient = createMockClient({ stationRecords });
      setDocClient(mockClient);

      const res = await handleStationSummary();
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.stations).toHaveLength(10);
      expect(body.stations[0]).toEqual({ stationId: 1, uniqueVisitors: 2 });
      expect(body.stations[2]).toEqual({ stationId: 3, uniqueVisitors: 3 });
      expect(body.stations[6]).toEqual({ stationId: 7, uniqueVisitors: 1 });
      // Other stations should have 0
      expect(body.stations[1]).toEqual({ stationId: 2, uniqueVisitors: 0 });
      expect(body.stations[4]).toEqual({ stationId: 5, uniqueVisitors: 0 });
    });

    it('filters expired records from summary counts', async () => {
      const stationRecords = {
        1: [
          makeRecord('tag-a', 1, '2023-11-14T22:00:00.000Z', FIXED_SECONDS + 1000), // valid
          makeRecord('tag-b', 1, '2023-11-14T21:00:00.000Z', FIXED_SECONDS - 1),    // expired
        ],
      };
      const mockClient = createMockClient({ stationRecords });
      setDocClient(mockClient);

      const res = await handleStationSummary();
      const body = JSON.parse(res.body);

      expect(body.stations[0]).toEqual({ stationId: 1, uniqueVisitors: 1 });
    });

    it('returns 500 when DynamoDB query fails', async () => {
      const mockClient = createMockClient({ shouldFail: true });
      setDocClient(mockClient);

      const res = await handleStationSummary();
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(500);
      expect(body.error).toBe('internal_error');
    });

    it('counts duplicate tags as single unique visitor', async () => {
      const stationRecords = {
        5: [
          makeRecord('tag-a', 5, '2023-11-14T22:00:00.000Z'),
          makeRecord('tag-a', 5, '2023-11-14T21:00:00.000Z'), // same tag
          makeRecord('tag-a', 5, '2023-11-14T20:00:00.000Z'), // same tag
        ],
      };
      const mockClient = createMockClient({ stationRecords });
      setDocClient(mockClient);

      const res = await handleStationSummary();
      const body = JSON.parse(res.body);

      expect(body.stations[4]).toEqual({ stationId: 5, uniqueVisitors: 1 });
    });
  });
});
