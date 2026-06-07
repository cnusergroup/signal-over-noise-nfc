import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleCheckin } from '../../src/checkin-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

/**
 * Unit tests for the `afterParty` flag stamped on newly-written check-in
 * records by the check-in handler (Requirements 1.1, 1.2, 1.6).
 *
 * The handler computes `afterParty: isAfterPartyCheckin(currentTime)` at write
 * time. The default time gate is 2026-06-28T09:00:00Z (no env var required).
 * We stub the injectable clock via `setClock` to place the current time before
 * and after the gate, then inspect the captured `PutCommand` Item.
 *
 * DynamoDB is mocked with the project's injectable client convention
 * (`setDocClient` + a `vi.fn()` `send`), which captures every issued command
 * on `mockClient.send.mock.calls` — the same call-capture role that
 * `aws-sdk-client-mock`'s `ddbMock.commandCalls(PutCommand)` provides.
 */

/**
 * Creates a mock DynamoDB DocumentClient that responds based on key patterns.
 * Mirrors the convention used in checkin-handler.test.mjs.
 */
function createMockClient(options = {}) {
  const {
    scannerMapping = { stationId: 3 },
    tagExists = true,
    existingCheckin = null,
  } = options;

  return {
    send: vi.fn(async (command) => {
      const commandName = command.constructor.name;
      const key = command.input?.Key;

      if (commandName === 'GetCommand') {
        // Scanner lookup
        if (key?.PK?.startsWith('SCANNER#')) {
          return { Item: scannerMapping };
        }
        // Tag registry lookup
        if (key?.SK === 'REGISTRY') {
          return {
            Item: tagExists
              ? { PK: key.PK, SK: 'REGISTRY', tagId: key.PK.replace('TAG#', '') }
              : undefined,
          };
        }
        // Existing check-in lookup (cooldown)
        if (key?.SK?.startsWith('CHECKIN#')) {
          return { Item: existingCheckin };
        }
        return { Item: undefined };
      }

      if (commandName === 'PutCommand') {
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

/** Returns the captured PutCommand Item for the check-in write, or undefined. */
function findPutItem(mockClient) {
  const putCall = mockClient.send.mock.calls.find(
    ([cmd]) => cmd.constructor.name === 'PutCommand'
  );
  return putCall ? putCall[0].input.Item : undefined;
}

/** Counts how many PutCommand calls were issued. */
function countPutCommands(mockClient) {
  return mockClient.send.mock.calls.filter(
    ([cmd]) => cmd.constructor.name === 'PutCommand'
  ).length;
}

describe('checkin-handler afterParty stamping', () => {
  // Default gate: 2026-06-28T09:00:00Z === 1782637200000 ms
  const GATE_MS = Date.parse('2026-06-28T09:00:00Z');
  const PRE_GATE_MS = GATE_MS - 1000; // 2026-06-28T08:59:59Z
  const POST_GATE_MS = GATE_MS + 1000; // 2026-06-28T09:00:01Z

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  describe('pre-gate writes (Requirement 1.2)', () => {
    it('stamps afterParty: false when current time is before the gate', async () => {
      setClock(() => PRE_GATE_MS);
      const mockClient = createMockClient({ existingCheckin: null });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      expect(res.statusCode).toBe(200);

      const item = findPutItem(mockClient);
      expect(item).toBeDefined();
      expect(item.afterParty).toBe(false);
    });
  });

  describe('post-gate writes (Requirement 1.1)', () => {
    it('stamps afterParty: true when current time is after the gate', async () => {
      setClock(() => POST_GATE_MS);
      const mockClient = createMockClient({ existingCheckin: null });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      expect(res.statusCode).toBe(200);

      const item = findPutItem(mockClient);
      expect(item).toBeDefined();
      expect(item.afterParty).toBe(true);
    });

    it('stamps afterParty: true exactly at the gate boundary (inclusive)', async () => {
      setClock(() => GATE_MS);
      const mockClient = createMockClient({ existingCheckin: null });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      expect(res.statusCode).toBe(200);

      const item = findPutItem(mockClient);
      expect(item).toBeDefined();
      expect(item.afterParty).toBe(true);
    });
  });

  describe('cooldown-rejected requests do not write afterParty (Requirement 1.6)', () => {
    it('issues no PutCommand when the request is rejected by cooldown', async () => {
      // Existing check-in 5s ago → within the 30s cooldown window.
      setClock(() => POST_GATE_MS);
      const lastCheckinTime = new Date(POST_GATE_MS - 5000).toISOString();
      const mockClient = createMockClient({
        existingCheckin: { checkinTime: lastCheckinTime },
      });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      expect(res.statusCode).toBe(429);

      // No new check-in record is written, so afterParty cannot be mutated.
      expect(countPutCommands(mockClient)).toBe(0);
      expect(findPutItem(mockClient)).toBeUndefined();
    });

    it('does not mutate afterParty on a pre-existing record during cooldown', async () => {
      // A pre-gate record already exists (afterParty would have been false).
      // A second scan after the gate is still inside cooldown → rejected.
      setClock(() => GATE_MS + 2000);
      const lastCheckinTime = new Date(PRE_GATE_MS).toISOString();
      const mockClient = createMockClient({
        existingCheckin: { checkinTime: lastCheckinTime, afterParty: false },
      });
      setDocClient(mockClient);

      const res = await handleCheckin({ tagId: 'tag-abc', scannerId: 'scanner-1' });
      expect(res.statusCode).toBe(429);
      expect(countPutCommands(mockClient)).toBe(0);
    });
  });
});
