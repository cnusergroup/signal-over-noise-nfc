import { describe, it, expect } from 'vitest';
import { ok, buildResponse, buildErrorResponse } from '../../src/utils/response.mjs';
import { validateCheckinRequest, validateStationId, validateTagId } from '../../src/validator.mjs';
import { generateRewardCode, maskTagId } from '../../src/utils/crypto.mjs';
import { checkinTTL, missionTTL, setClock, resetClock, now, isoNow } from '../../src/utils/time.mjs';
import { route } from '../../src/router.mjs';

describe('Project structure verification', () => {
  describe('response utilities', () => {
    it('builds a JSON response with CORS headers', () => {
      const res = buildResponse(200, { success: true });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    });

    it('builds an error response with field', () => {
      const res = buildErrorResponse(400, 'missing_field', 'tagId is required', 'tagId');
      const body = JSON.parse(res.body);
      expect(body.error).toBe('missing_field');
      expect(body.message).toBe('tagId is required');
      expect(body.field).toBe('tagId');
    });
  });

  describe('validator', () => {
    it('rejects missing tagId', () => {
      expect(validateCheckinRequest({})).toEqual({ valid: false, error: 'missing_field', field: 'tagId' });
    });

    it('rejects missing scannerId', () => {
      expect(validateCheckinRequest({ tagId: 'abc' })).toEqual({ valid: false, error: 'missing_field', field: 'scannerId' });
    });

    it('accepts valid check-in request', () => {
      expect(validateCheckinRequest({ tagId: 'abc', scannerId: 'scanner1' })).toEqual({ valid: true });
    });

    it('validates station ID range', () => {
      expect(validateStationId(0).valid).toBe(false);
      expect(validateStationId(11).valid).toBe(false);
      expect(validateStationId(5).valid).toBe(true);
      expect(validateStationId('abc').valid).toBe(false);
    });

    it('validates tagId non-empty', () => {
      expect(validateTagId('').valid).toBe(false);
      expect(validateTagId('   ').valid).toBe(false);
      expect(validateTagId('tag123').valid).toBe(true);
    });
  });

  describe('crypto utilities', () => {
    it('generates reward code of specified length', () => {
      const code = generateRewardCode(20);
      expect(code.length).toBe(20);
      expect(/^[0-9a-f]+$/.test(code)).toBe(true);
    });

    it('generates reward code at least 16 chars by default', () => {
      const code = generateRewardCode();
      expect(code.length).toBeGreaterThanOrEqual(16);
    });

    it('masks tag ID correctly', () => {
      expect(maskTagId('abcdefghijklmnop')).toBe('abcd****mnop');
      expect(maskTagId('short')).toBe('short');
    });
  });

  describe('time utilities', () => {
    it('injectable clock works', () => {
      setClock(() => 1700000000000);
      expect(now()).toBe(1700000000000);
      expect(isoNow()).toBe(new Date(1700000000000).toISOString());
      resetClock();
    });

    it('calculates check-in TTL correctly', () => {
      const creationMs = 1700000000000;
      const expected = Math.floor(creationMs / 1000) + 30 * 24 * 60 * 60;
      expect(checkinTTL(creationMs)).toBe(expected);
    });

    it('calculates mission TTL correctly', () => {
      const endMs = 1700100000000;
      const expected = Math.floor(endMs / 1000) + 30 * 24 * 60 * 60;
      expect(missionTTL(endMs)).toBe(expected);
    });
  });

  describe('router entry point', () => {
    it('returns 404 for unknown routes', async () => {
      const event = {
        requestContext: { http: { method: 'GET', path: '/unknown' } },
      };
      const res = await route(event);
      expect(res.statusCode).toBe(404);
    });
  });
});
