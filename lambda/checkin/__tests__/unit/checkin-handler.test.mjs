import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleCheckin } from '../../src/checkin-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

/**
 * Creates a mock DynamoDB DocumentClient that responds based on key patterns.
 */
function createMockClient(options = {}) {
  const {
    scannerMapping = { stationId: 3 },
    tagExists = true,
    existingCheckin = null,
    putShouldFail = false,
    getShouldFail = false,
  } = options;

  return {
    send: vi.fn(async (command) => {
      const commandName = command.constructor.name;
      const key = command.input?.Key;

      if (getShouldFail) {
        throw new Error('DynamoDB unavailable');
      }

      if (commandName === 'GetCommand') {
        // Scanner lookup
        if (key?.PK?.startsWith('SCANNER#')) {
          return { Item: scannerMapping };
        }
        // Tag registry lookup
        if (key?.SK === 'REGISTRY') {
          return { Item: tagExists ? { PK: key.PK, SK: 'REGISTRY', tagId: key.PK.replace('TAG#', '') } : undefined };
        }
        // Existing check-in lookup
        if (key?.SK?.startsWith('CHECKIN#')) {
          return { Item: existingCheckin };
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
        // Mission queries return empty results by default
        return { Items: [] };
      }

      return {};
    }),
  };
}

describe('checkin-handler', () => {
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

  describe('input validation', () => {
    it('returns 400 when tagId is missing', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleCheckin({ scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('missing_field');
      expect(body.field).toBe('tagId');
    });

    it('returns 400 when tagId is empty string', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: '', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.field).toBe('tagId');
    });

    it('returns 400 when tagId is whitespace only', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: '   ', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.field).toBe('tagId');
    });

    it('returns 400 when scannerId is missing', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('missing_field');
      expect(body.field).toBe('scannerId');
    });

    it('returns 400 when scannerId is empty string', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: '' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.field).toBe('scannerId');
    });

    it('returns 400 when body is null', async () => {
      const mockClient = createMockClient();
      setDocClient(mockClient);

      const res = await handleCheckin(null);
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.field).toBe('tagId');
    });
  });

  describe('scanner validation', () => {
    it('returns 400 when scanner is not found', async () => {
      const mockClient = createMockClient({ scannerMapping: null });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'unknown-scanner' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('invalid_field');
      expect(body.field).toBe('scannerId');
      expect(body.message).toContain('Unrecognized scanner');
    });

    it('returns 400 when scanner record has no stationId', async () => {
      const mockClient = createMockClient({ scannerMapping: { PK: 'SCANNER#x', SK: 'CONFIG' } });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'bad-scanner' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('invalid_field');
    });
  });

  describe('tag validation', () => {
    it('returns 404 when tag is not in registry', async () => {
      const mockClient = createMockClient({ tagExists: false });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'unknown-tag', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(404);
      expect(body.error).toBe('not_found');
      expect(body.message).toContain('Unrecognized NFC tag');
    });
  });

  describe('successful check-in (first visit)', () => {
    it('returns 200 with correct response fields', async () => {
      const mockClient = createMockClient({ existingCheckin: null });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.tagId).toBe('tag-abc');
      expect(body.stationId).toBe(3);
      expect(body.checkinTime).toBe(new Date(FIXED_TIME).toISOString());
      expect(body.missions.numberedVisit).toEqual([]);
      expect(body.missions.earlyBird).toBeNull();
      expect(body.missions.luckyDraw).toBeNull();
      expect(body.missions.lastCall).toBeNull();
      expect(body.missions.comboCompleted).toEqual([]);
      expect(body.missions.stampRally).toEqual({ completed: false, rewardCode: null });
    });

    it('writes check-in record with correct attributes', async () => {
      const mockClient = createMockClient({ existingCheckin: null });
      setDocClient(mockClient);

      await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });

      // Find the PutCommand call
      const putCall = mockClient.send.mock.calls.find(
        ([cmd]) => cmd.constructor.name === 'PutCommand'
      );
      expect(putCall).toBeDefined();

      const item = putCall[0].input.Item;
      expect(item.PK).toBe('TAG#tag-abc');
      expect(item.SK).toBe('CHECKIN#3');
      expect(item.GSI1PK).toBe('STATION#3');
      expect(item.GSI1SK).toBe(`CHECKIN#${new Date(FIXED_TIME).toISOString()}`);
      expect(item.tagId).toBe('tag-abc');
      expect(item.stationId).toBe(3);
      expect(item.checkinTime).toBe(new Date(FIXED_TIME).toISOString());
      // TTL = floor(1700000000000/1000) + 30*24*60*60 = 1700000000 + 2592000
      expect(item.ttl).toBe(1700000000 + 2592000);
    });
  });

  describe('cooldown enforcement', () => {
    it('returns 429 when cooldown is active (10s elapsed)', async () => {
      const lastCheckinTime = new Date(FIXED_TIME - 10000).toISOString(); // 10s ago
      const mockClient = createMockClient({
        existingCheckin: { checkinTime: lastCheckinTime },
      });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(429);
      expect(body.error).toBe('cooldown_active');
      expect(body.remainingSeconds).toBe(20); // 30 - 10 = 20
    });

    it('returns 429 with missions included', async () => {
      const lastCheckinTime = new Date(FIXED_TIME - 5000).toISOString(); // 5s ago
      const mockClient = createMockClient({
        existingCheckin: { checkinTime: lastCheckinTime },
      });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(429);
      expect(body.remainingSeconds).toBe(25); // 30 - 5 = 25
      expect(body.missions.numberedVisit).toEqual([]);
      expect(body.missions.earlyBird).toBeNull();
      expect(body.missions.luckyDraw).toBeNull();
      expect(body.missions.lastCall).toBeNull();
      expect(body.missions.comboCompleted).toEqual([]);
      expect(body.missions.stampRally).toEqual({ completed: false, rewardCode: null });
    });

    it('allows check-in when cooldown has expired (31s elapsed)', async () => {
      const lastCheckinTime = new Date(FIXED_TIME - 31000).toISOString(); // 31s ago
      const mockClient = createMockClient({
        existingCheckin: { checkinTime: lastCheckinTime },
      });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
    });

    it('allows check-in when cooldown is exactly 30s (boundary)', async () => {
      const lastCheckinTime = new Date(FIXED_TIME - 30000).toISOString(); // exactly 30s ago
      const mockClient = createMockClient({
        existingCheckin: { checkinTime: lastCheckinTime },
      });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
    });

    it('returns 429 at 29s (just under cooldown)', async () => {
      const lastCheckinTime = new Date(FIXED_TIME - 29000).toISOString(); // 29s ago
      const mockClient = createMockClient({
        existingCheckin: { checkinTime: lastCheckinTime },
      });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(429);
      expect(body.remainingSeconds).toBe(1); // 30 - 29 = 1
    });
  });

  describe('error handling', () => {
    it('returns 500 when DynamoDB PutItem fails', async () => {
      const mockClient = createMockClient({ putShouldFail: true });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(500);
      expect(body.error).toBe('internal_error');
    });

    it('returns 500 when DynamoDB GetItem fails on scanner lookup', async () => {
      const mockClient = {
        send: vi.fn(async (command) => {
          const key = command.input?.Key;
          if (key?.PK?.startsWith('SCANNER#')) {
            throw new Error('DynamoDB unavailable');
          }
          return { Item: undefined };
        }),
      };
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(500);
      expect(body.error).toBe('internal_error');
    });
  });
});
