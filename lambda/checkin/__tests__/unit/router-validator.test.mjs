import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { route } from '../../src/router.mjs';
import {
  validateCheckinRequest,
  validateTagId,
  validateStationId,
  validateMissionParams,
  validateComboParams,
} from '../../src/validator.mjs';

// Mock all handler modules so we can test routing in isolation
vi.mock('../../src/checkin-handler.mjs', () => ({
  handleCheckin: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"success":true}' }),
}));
vi.mock('../../src/progress-handler.mjs', () => ({
  handleProgress: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"tagId":"abc"}' }),
}));
vi.mock('../../src/station-handler.mjs', () => ({
  handleStationTraffic: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"stationId":1}' }),
  handleStationSummary: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"stations":[]}' }),
}));
vi.mock('../../src/leaderboard-handler.mjs', () => ({
  handleLeaderboard: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"entries":[]}' }),
}));
vi.mock('../../src/admin-handler.mjs', () => ({
  handleMissionAdmin: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"missions":[]}' }),
}));
vi.mock('../../src/combo-handler.mjs', () => ({
  handleComboAdmin: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"combos":[]}' }),
}));

function makeEvent(method, path, { body, headers, pathParameters } = {}) {
  return {
    requestContext: { http: { method, path } },
    headers: headers || {},
    pathParameters: pathParameters || {},
    body: body ? JSON.stringify(body) : null,
    isBase64Encoded: false,
  };
}

describe('Validator', () => {
  describe('validateCheckinRequest', () => {
    it('returns valid for correct input', () => {
      expect(validateCheckinRequest({ tagId: 'abc', scannerId: 'sc1' })).toEqual({ valid: true });
    });

    it('rejects null body', () => {
      const result = validateCheckinRequest(null);
      expect(result.valid).toBe(false);
      expect(result.field).toBe('tagId');
    });

    it('rejects missing tagId', () => {
      const result = validateCheckinRequest({ scannerId: 'sc1' });
      expect(result.valid).toBe(false);
      expect(result.field).toBe('tagId');
    });

    it('rejects empty tagId', () => {
      const result = validateCheckinRequest({ tagId: '   ', scannerId: 'sc1' });
      expect(result.valid).toBe(false);
      expect(result.field).toBe('tagId');
    });

    it('rejects missing scannerId', () => {
      const result = validateCheckinRequest({ tagId: 'abc' });
      expect(result.valid).toBe(false);
      expect(result.field).toBe('scannerId');
    });

    it('rejects empty scannerId', () => {
      const result = validateCheckinRequest({ tagId: 'abc', scannerId: '' });
      expect(result.valid).toBe(false);
      expect(result.field).toBe('scannerId');
    });
  });

  describe('validateTagId', () => {
    it('accepts valid tagId', () => {
      expect(validateTagId('abc123')).toEqual({ valid: true });
    });

    it('rejects null', () => {
      expect(validateTagId(null).valid).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateTagId('').valid).toBe(false);
    });

    it('rejects whitespace-only', () => {
      expect(validateTagId('   ').valid).toBe(false);
    });
  });

  describe('validateStationId', () => {
    it('accepts valid station IDs 1-10', () => {
      for (let i = 1; i <= 10; i++) {
        expect(validateStationId(i)).toEqual({ valid: true });
        expect(validateStationId(String(i))).toEqual({ valid: true });
      }
    });

    it('rejects 0', () => {
      expect(validateStationId(0).valid).toBe(false);
    });

    it('rejects 11', () => {
      expect(validateStationId(11).valid).toBe(false);
    });

    it('rejects non-integer', () => {
      expect(validateStationId(1.5).valid).toBe(false);
      expect(validateStationId('abc').valid).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateStationId('').valid).toBe(false);
    });

    it('rejects null/undefined', () => {
      expect(validateStationId(null).valid).toBe(false);
      expect(validateStationId(undefined).valid).toBe(false);
    });
  });

  describe('validateMissionParams', () => {
    const validMission = {
      type: 'numbered_visit',
      name: 'Test Mission',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T12:00:00Z',
      stationId: 5,
      milestones: [10, 50, 100],
    };

    it('accepts valid numbered_visit mission', () => {
      expect(validateMissionParams(validMission)).toEqual({ valid: true });
    });

    it('rejects null body', () => {
      expect(validateMissionParams(null).valid).toBe(false);
    });

    it('rejects missing type', () => {
      const { type, ...rest } = validMission;
      expect(validateMissionParams(rest).valid).toBe(false);
    });

    it('rejects invalid type', () => {
      expect(validateMissionParams({ ...validMission, type: 'invalid' }).valid).toBe(false);
    });

    it('rejects missing name', () => {
      const { name, ...rest } = validMission;
      expect(validateMissionParams(rest).valid).toBe(false);
    });

    it('rejects name over 200 chars', () => {
      expect(validateMissionParams({ ...validMission, name: 'x'.repeat(201) }).valid).toBe(false);
    });

    it('rejects endTime <= startTime', () => {
      expect(validateMissionParams({
        ...validMission,
        startTime: '2024-01-01T12:00:00Z',
        endTime: '2024-01-01T00:00:00Z',
      }).valid).toBe(false);
    });

    it('rejects equal start and end time', () => {
      expect(validateMissionParams({
        ...validMission,
        startTime: '2024-01-01T12:00:00Z',
        endTime: '2024-01-01T12:00:00Z',
      }).valid).toBe(false);
    });

    it('accepts valid lucky_draw mission', () => {
      expect(validateMissionParams({
        type: 'lucky_draw',
        name: 'Draw',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T12:00:00Z',
        winnerCount: 5,
        prizeDescription: 'A prize',
      })).toEqual({ valid: true });
    });

    it('rejects lucky_draw with winnerCount > 100', () => {
      expect(validateMissionParams({
        type: 'lucky_draw',
        name: 'Draw',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T12:00:00Z',
        winnerCount: 101,
      }).valid).toBe(false);
    });

    it('rejects lucky_draw with prizeDescription > 500 chars', () => {
      expect(validateMissionParams({
        type: 'lucky_draw',
        name: 'Draw',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T12:00:00Z',
        winnerCount: 5,
        prizeDescription: 'x'.repeat(501),
      }).valid).toBe(false);
    });

    it('allows partial updates when isUpdate=true', () => {
      expect(validateMissionParams({ name: 'Updated' }, true)).toEqual({ valid: true });
    });
  });

  describe('validateComboParams', () => {
    const validCombo = {
      name: 'Tech Trio',
      stations: [1, 3, 5],
      reward: 'Free coffee',
    };

    it('accepts valid combo', () => {
      expect(validateComboParams(validCombo)).toEqual({ valid: true });
    });

    it('rejects null body', () => {
      expect(validateComboParams(null).valid).toBe(false);
    });

    it('rejects missing name', () => {
      const { name, ...rest } = validCombo;
      expect(validateComboParams(rest).valid).toBe(false);
    });

    it('rejects name over 100 chars', () => {
      expect(validateComboParams({ ...validCombo, name: 'x'.repeat(101) }).valid).toBe(false);
    });

    it('rejects missing stations', () => {
      const { stations, ...rest } = validCombo;
      expect(validateComboParams(rest).valid).toBe(false);
    });

    it('rejects fewer than 2 stations', () => {
      expect(validateComboParams({ ...validCombo, stations: [1] }).valid).toBe(false);
    });

    it('rejects more than 10 stations', () => {
      expect(validateComboParams({ ...validCombo, stations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }).valid).toBe(false);
    });

    it('rejects duplicate stations', () => {
      expect(validateComboParams({ ...validCombo, stations: [1, 1, 3] }).valid).toBe(false);
    });

    it('rejects station outside 1-10', () => {
      expect(validateComboParams({ ...validCombo, stations: [0, 5] }).valid).toBe(false);
      expect(validateComboParams({ ...validCombo, stations: [5, 11] }).valid).toBe(false);
    });

    it('rejects missing reward', () => {
      const { reward, ...rest } = validCombo;
      expect(validateComboParams(rest).valid).toBe(false);
    });

    it('rejects reward over 200 chars', () => {
      expect(validateComboParams({ ...validCombo, reward: 'x'.repeat(201) }).valid).toBe(false);
    });
  });

});

describe('Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('OPTIONS (CORS preflight)', () => {
    it('returns 204 for OPTIONS requests', async () => {
      const res = await route(makeEvent('OPTIONS', '/checkin'));
      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /checkin', () => {
    it('routes to checkin handler with valid body', async () => {
      const { handleCheckin } = await import('../../src/checkin-handler.mjs');
      const res = await route(makeEvent('POST', '/checkin', {
        body: { tagId: 'tag123', scannerId: 'scanner1' },
      }));
      expect(res.statusCode).toBe(200);
      expect(handleCheckin).toHaveBeenCalledWith({ tagId: 'tag123', scannerId: 'scanner1' });
    });

    it('returns 400 for missing tagId', async () => {
      const res = await route(makeEvent('POST', '/checkin', {
        body: { scannerId: 'scanner1' },
      }));
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('missing_field');
      expect(body.field).toBe('tagId');
    });

    it('returns 400 for missing scannerId', async () => {
      const res = await route(makeEvent('POST', '/checkin', {
        body: { tagId: 'tag123' },
      }));
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('missing_field');
      expect(body.field).toBe('scannerId');
    });

    it('returns 400 for empty body', async () => {
      const res = await route(makeEvent('POST', '/checkin'));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /checkin/{tagId}', () => {
    it('routes to progress handler', async () => {
      const { handleProgress } = await import('../../src/progress-handler.mjs');
      const res = await route(makeEvent('GET', '/checkin/tag123', {
        pathParameters: { tagId: 'tag123' },
      }));
      expect(res.statusCode).toBe(200);
      expect(handleProgress).toHaveBeenCalledWith('tag123');
    });

    it('returns 400 for empty tagId in path', async () => {
      const res = await route(makeEvent('GET', '/checkin/%20', {
        pathParameters: { tagId: ' ' },
      }));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /stations', () => {
    it('routes to station summary handler', async () => {
      const { handleStationSummary } = await import('../../src/station-handler.mjs');
      const res = await route(makeEvent('GET', '/stations'));
      expect(res.statusCode).toBe(200);
      expect(handleStationSummary).toHaveBeenCalled();
    });
  });

  describe('GET /stations/{stationId}', () => {
    it('routes to station traffic handler for valid stationId', async () => {
      const { handleStationTraffic } = await import('../../src/station-handler.mjs');
      const res = await route(makeEvent('GET', '/stations/5', {
        pathParameters: { stationId: '5' },
      }));
      expect(res.statusCode).toBe(200);
      expect(handleStationTraffic).toHaveBeenCalledWith(5);
    });

    it('returns 400 for invalid stationId', async () => {
      const res = await route(makeEvent('GET', '/stations/abc', {
        pathParameters: { stationId: 'abc' },
      }));
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('invalid_field');
      expect(body.field).toBe('stationId');
    });

    it('returns 400 for stationId out of range', async () => {
      const res = await route(makeEvent('GET', '/stations/11', {
        pathParameters: { stationId: '11' },
      }));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /leaderboard', () => {
    it('routes to leaderboard handler', async () => {
      const { handleLeaderboard } = await import('../../src/leaderboard-handler.mjs');
      const res = await route(makeEvent('GET', '/leaderboard'));
      expect(res.statusCode).toBe(200);
      expect(handleLeaderboard).toHaveBeenCalled();
    });
  });

  describe('Admin routes - routing', () => {
    it('routes POST /missions to admin handler', async () => {
      const { handleMissionAdmin } = await import('../../src/admin-handler.mjs');
      const res = await route(makeEvent('POST', '/missions', {
        body: { type: 'numbered_visit', name: 'Test', startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T12:00:00Z', stationId: 3, milestones: [10] },
      }));
      expect(res.statusCode).toBe(200);
      expect(handleMissionAdmin).toHaveBeenCalled();
    });

    it('routes POST /combos to combo handler', async () => {
      const { handleComboAdmin } = await import('../../src/combo-handler.mjs');
      const res = await route(makeEvent('POST', '/combos', {
        body: { name: 'Combo', stations: [1, 2, 3], reward: 'Prize' },
      }));
      expect(res.statusCode).toBe(200);
      expect(handleComboAdmin).toHaveBeenCalled();
    });

    it('routes DELETE /missions/{id} to admin handler', async () => {
      const { handleMissionAdmin } = await import('../../src/admin-handler.mjs');
      const res = await route(makeEvent('DELETE', '/missions/m1', {
        pathParameters: { missionId: 'm1' },
      }));
      expect(res.statusCode).toBe(200);
      expect(handleMissionAdmin).toHaveBeenCalledWith({ method: 'DELETE', missionId: 'm1', action: 'delete' });
    });

    it('routes GET /missions to admin handler', async () => {
      const { handleMissionAdmin } = await import('../../src/admin-handler.mjs');
      const res = await route(makeEvent('GET', '/missions'));
      expect(res.statusCode).toBe(200);
      expect(handleMissionAdmin).toHaveBeenCalled();
    });

    it('routes GET /combos to combo handler', async () => {
      const { handleComboAdmin } = await import('../../src/combo-handler.mjs');
      const res = await route(makeEvent('GET', '/combos'));
      expect(res.statusCode).toBe(200);
      expect(handleComboAdmin).toHaveBeenCalled();
    });

    it('routes GET /missions/{id}/winners to admin handler', async () => {
      const { handleMissionAdmin } = await import('../../src/admin-handler.mjs');
      const res = await route(makeEvent('GET', '/missions/m1/winners', {
        pathParameters: { missionId: 'm1' },
      }));
      expect(res.statusCode).toBe(200);
      expect(handleMissionAdmin).toHaveBeenCalled();
    });
  });

  describe('404 for unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const res = await route(makeEvent('GET', '/unknown'));
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('not_found');
    });

    it('returns 404 for wrong method on known path', async () => {
      const res = await route(makeEvent('DELETE', '/checkin'));
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Error handling', () => {
    it('returns 500 when handler throws', async () => {
      const { handleCheckin } = await import('../../src/checkin-handler.mjs');
      handleCheckin.mockRejectedValueOnce(new Error('DB failure'));
      const res = await route(makeEvent('POST', '/checkin', {
        body: { tagId: 'tag1', scannerId: 'sc1' },
      }));
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('internal_error');
    });
  });
});
