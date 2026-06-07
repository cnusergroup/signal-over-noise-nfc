import { describe, it, expect, afterEach } from 'vitest';
import { buildKey, buildKeyCondition, buildGSIKeyCondition } from '../../src/utils/dynamo.mjs';
import {
  now, isoNow, toISO, fromISO,
  checkinTTL, missionTTL, isExpired, filterExpired,
  setClock, resetClock,
} from '../../src/utils/time.mjs';
import { generateRewardCode, maskTagId } from '../../src/utils/crypto.mjs';
import {
  ok, created, noContent, missingField, invalidField,
  unauthorized, notFound, conflict, cooldown, internalError,
  success, error, buildResponse, buildErrorResponse,
} from '../../src/utils/response.mjs';

describe('utils/dynamo', () => {
  describe('buildKey', () => {
    it('returns PK and SK object', () => {
      const key = buildKey('TAG#abc123', 'CHECKIN#3');
      expect(key).toEqual({ PK: 'TAG#abc123', SK: 'CHECKIN#3' });
    });
  });

  describe('buildKeyCondition', () => {
    it('builds PK-only condition', () => {
      const result = buildKeyCondition('TAG#abc');
      expect(result.KeyConditionExpression).toBe('PK = :pk');
      expect(result.ExpressionAttributeValues).toEqual({ ':pk': 'TAG#abc' });
    });

    it('builds PK + SK begins_with condition', () => {
      const result = buildKeyCondition('TAG#abc', { beginsWith: 'CHECKIN#' });
      expect(result.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :skPrefix)');
      expect(result.ExpressionAttributeValues).toEqual({
        ':pk': 'TAG#abc',
        ':skPrefix': 'CHECKIN#',
      });
    });

    it('builds PK + SK equals condition', () => {
      const result = buildKeyCondition('TAG#abc', { equals: 'REGISTRY' });
      expect(result.KeyConditionExpression).toBe('PK = :pk AND SK = :sk');
      expect(result.ExpressionAttributeValues).toEqual({
        ':pk': 'TAG#abc',
        ':sk': 'REGISTRY',
      });
    });
  });

  describe('buildGSIKeyCondition', () => {
    it('builds GSI1 PK-only condition', () => {
      const result = buildGSIKeyCondition('GSI1', 'STATION#5');
      expect(result.IndexName).toBe('GSI1');
      expect(result.KeyConditionExpression).toBe('GSI1PK = :gsiPk');
      expect(result.ExpressionAttributeValues).toEqual({ ':gsiPk': 'STATION#5' });
    });

    it('builds GSI1 PK + SK begins_with condition', () => {
      const result = buildGSIKeyCondition('GSI1', 'STATION#5', { beginsWith: 'CHECKIN#' });
      expect(result.IndexName).toBe('GSI1');
      expect(result.KeyConditionExpression).toBe('GSI1PK = :gsiPk AND begins_with(GSI1SK, :gsiSkPrefix)');
      expect(result.ExpressionAttributeValues).toEqual({
        ':gsiPk': 'STATION#5',
        ':gsiSkPrefix': 'CHECKIN#',
      });
    });

    it('builds GSI2 PK + SK equals condition', () => {
      const result = buildGSIKeyCondition('GSI2', 'SOME_KEY', { equals: 'EXACT_VALUE' });
      expect(result.IndexName).toBe('GSI2');
      expect(result.KeyConditionExpression).toBe('GSI2PK = :gsiPk AND GSI2SK = :gsiSk');
      expect(result.ExpressionAttributeValues).toEqual({
        ':gsiPk': 'SOME_KEY',
        ':gsiSk': 'EXACT_VALUE',
      });
    });
  });
});

describe('utils/time', () => {
  afterEach(() => {
    resetClock();
  });

  describe('injectable clock', () => {
    it('uses real time by default', () => {
      const before = Date.now();
      const result = now();
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });

    it('uses injected clock', () => {
      const fixedTime = 1700000000000;
      setClock(() => fixedTime);
      expect(now()).toBe(fixedTime);
      expect(isoNow()).toBe(new Date(fixedTime).toISOString());
    });
  });

  describe('ISO helpers', () => {
    it('toISO converts ms to ISO string', () => {
      expect(toISO(0)).toBe('1970-01-01T00:00:00.000Z');
      expect(toISO(1700000000000)).toBe(new Date(1700000000000).toISOString());
    });

    it('fromISO converts ISO string to ms', () => {
      expect(fromISO('1970-01-01T00:00:00.000Z')).toBe(0);
      expect(fromISO('2023-11-14T22:13:20.000Z')).toBe(1700000000000);
    });
  });

  describe('TTL calculators', () => {
    it('checkinTTL = floor(ms/1000) + 30 days', () => {
      const creationMs = 1700000000000; // 1700000000 seconds
      const expected = 1700000000 + 30 * 24 * 60 * 60; // + 2592000
      expect(checkinTTL(creationMs)).toBe(expected);
    });

    it('checkinTTL floors fractional milliseconds', () => {
      const creationMs = 1700000000500; // 1700000000.5 seconds -> floor to 1700000000
      const expected = 1700000000 + 30 * 24 * 60 * 60;
      expect(checkinTTL(creationMs)).toBe(expected);
    });

    it('missionTTL = floor(endMs/1000) + 30 days', () => {
      const endMs = 1700100000000;
      const expected = 1700100000 + 30 * 24 * 60 * 60;
      expect(missionTTL(endMs)).toBe(expected);
    });
  });

  describe('expiration checks', () => {
    it('isExpired returns true when TTL is in the past', () => {
      setClock(() => 1700000000000); // current = 1700000000 seconds
      expect(isExpired(1699999999)).toBe(true);
    });

    it('isExpired returns false when TTL is in the future', () => {
      setClock(() => 1700000000000);
      expect(isExpired(1700000001)).toBe(false);
    });

    it('isExpired returns false when TTL equals current time', () => {
      setClock(() => 1700000000000);
      expect(isExpired(1700000000)).toBe(false);
    });

    it('filterExpired removes expired records', () => {
      setClock(() => 1700000000000); // current = 1700000000 seconds
      const records = [
        { id: 1, ttl: 1699999999 }, // expired
        { id: 2, ttl: 1700000001 }, // valid
        { id: 3, ttl: 1700000000 }, // exactly at boundary - not expired
        { id: 4 },                   // no TTL - kept
      ];
      const result = filterExpired(records);
      expect(result).toHaveLength(3);
      expect(result.map(r => r.id)).toEqual([2, 3, 4]);
    });
  });
});

describe('utils/crypto', () => {
  describe('generateRewardCode', () => {
    it('generates a code of at least 16 characters by default', () => {
      const code = generateRewardCode();
      expect(code.length).toBeGreaterThanOrEqual(16);
    });

    it('generates a hex string', () => {
      const code = generateRewardCode();
      expect(code).toMatch(/^[0-9a-f]+$/);
    });

    it('generates unique codes', () => {
      const codes = new Set();
      for (let i = 0; i < 100; i++) {
        codes.add(generateRewardCode());
      }
      expect(codes.size).toBe(100);
    });

    it('respects custom length parameter', () => {
      const code = generateRewardCode(32);
      expect(code.length).toBe(32);
    });

    it('generates exact length when specified', () => {
      const code = generateRewardCode(20);
      expect(code.length).toBe(20);
    });
  });

  describe('maskTagId', () => {
    it('masks middle of standard tag ID (first 4 + **** + last 4)', () => {
      expect(maskTagId('abcdefghijklmnop')).toBe('abcd****mnop');
    });

    it('masks a 12-character tag ID', () => {
      expect(maskTagId('123456789012')).toBe('1234****9012');
    });

    it('masks a 9-character tag ID', () => {
      expect(maskTagId('abcdefghi')).toBe('abcd****fghi');
    });

    it('returns short IDs as-is (8 chars or fewer cannot be meaningfully masked)', () => {
      expect(maskTagId('short')).toBe('short');
      expect(maskTagId('12345678')).toBe('12345678');
    });

    it('handles falsy values gracefully', () => {
      // Falsy values return as-is (null, undefined, empty string)
      expect(maskTagId(null)).toBeNull();
      expect(maskTagId(undefined)).toBeUndefined();
      expect(maskTagId('')).toBe('');
    });
  });
});

describe('utils/response', () => {
  describe('success responses', () => {
    it('ok returns 200 with body', () => {
      const res = ok({ data: 'test' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ data: 'test' });
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    });

    it('created returns 201 with body', () => {
      const res = created({ id: '123' });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ id: '123' });
    });

    it('noContent returns 204 with empty body', () => {
      const res = noContent();
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });
  });

  describe('error responses', () => {
    it('buildErrorResponse builds standard error format', () => {
      const res = buildErrorResponse(400, 'missing_field', 'Missing tagId', 'tagId');
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('missing_field');
      expect(body.message).toBe('Missing tagId');
      expect(body.field).toBe('tagId');
    });

    it('buildErrorResponse omits field when not provided', () => {
      const res = buildErrorResponse(500, 'internal_error', 'Something broke');
      const body = JSON.parse(res.body);
      expect(body.field).toBeUndefined();
    });

    it('missingField returns 400 with field name', () => {
      const res = missingField('scannerId');
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('missing_field');
      expect(body.field).toBe('scannerId');
      expect(body.message).toContain('scannerId');
    });

    it('invalidField returns 400 with field name', () => {
      const res = invalidField('stationId', 'Must be 1-10');
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('invalid_field');
      expect(body.field).toBe('stationId');
      expect(body.message).toBe('Must be 1-10');
    });

    it('unauthorized returns 401', () => {
      const res = unauthorized();
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(401);
      expect(body.error).toBe('unauthorized');
    });

    it('notFound returns 404', () => {
      const res = notFound('Tag not found');
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(404);
      expect(body.error).toBe('not_found');
      expect(body.message).toBe('Tag not found');
    });

    it('conflict returns 409', () => {
      const res = conflict('Mission already active');
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(409);
      expect(body.error).toBe('conflict');
    });

    it('cooldown returns 429 with remainingSeconds', () => {
      const res = cooldown(15);
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(429);
      expect(body.error).toBe('cooldown_active');
      expect(body.remainingSeconds).toBe(15);
    });

    it('cooldown includes missions when provided', () => {
      const missions = { numberedVisit: [{ visitorNumber: 5 }] };
      const res = cooldown(10, missions);
      const body = JSON.parse(res.body);
      expect(body.missions).toEqual(missions);
    });

    it('internalError returns 500', () => {
      const res = internalError('DB failure');
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(500);
      expect(body.error).toBe('internal_error');
      expect(body.message).toBe('DB failure');
    });

    it('internalError uses default message', () => {
      const res = internalError();
      const body = JSON.parse(res.body);
      expect(body.message).toBe('An internal error occurred');
    });
  });

  describe('CORS headers', () => {
    it('all responses include CORS headers', () => {
      const responses = [ok({}), buildErrorResponse(400, 'x', 'y'), cooldown(5)];
      for (const res of responses) {
        expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
        expect(res.headers['Access-Control-Allow-Methods']).toContain('GET');
        expect(res.headers['Access-Control-Allow-Methods']).toContain('POST');
      }
    });
  });
});
