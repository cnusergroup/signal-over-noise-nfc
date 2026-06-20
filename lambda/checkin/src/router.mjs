/**
 * Route dispatcher — matches HTTP method + path to handler functions.
 * Handles API Gateway HTTP API v2 event format.
 */

import { handleCheckin } from './checkin-handler.mjs';
import { handleProgress } from './progress-handler.mjs';
import { handleRewards, handleRedeemReward } from './rewards-handler.mjs';
import { handleStationTraffic, handleStationSummary } from './station-handler.mjs';
import { handleLeaderboard } from './leaderboard-handler.mjs';
import { handleMissionAdmin } from './admin-handler.mjs';
import { handleComboAdmin } from './combo-handler.mjs';
import { handleResetStats } from './reset-handler.mjs';
import {
  handleListUsers,
  handleCreateUser,
  handleResetUserPassword,
  handleDeleteUser,
} from './admin-users-handler.mjs';
import { handleVerify, handleSetEntitlement, handleRemoveEntitlement, handleGetEntitlement } from './verify-handler.mjs';
import {
  handleNicknameRegister,
  handleListParticipants,
  handleDraw,
  handleListWinners,
  handleGetLotteryConfig,
  handleSetLotteryConfig,
  handleResetLottery,
  handleAddWinner,
  handleAddParticipant,
  handleDeleteWinners,
  loadLotteryConfig,
} from './lottery-handler.mjs';

// Load lottery config from DynamoDB on cold start (non-blocking best-effort).
loadLotteryConfig().catch(() => {});
import {
  validateCheckinRequest,
  validateTagId,
  validateStationId,
  validateMissionParams,
  validateComboParams,
} from './validator.mjs';
import * as response from './utils/response.mjs';

/**
 * Parses the JSON body from the event, handling base64 encoding.
 * @param {object} event - API Gateway event
 * @returns {object|null} Parsed body or null
 */
function parseBody(event) {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extracts path parameters from the URL path.
 * Uses API Gateway pathParameters if available, otherwise parses manually.
 * @param {string} path - Request path
 * @param {object} pathParameters - API Gateway path parameters
 * @returns {object} Extracted parameters
 */
function extractPathParams(path, pathParameters) {
  if (pathParameters && Object.keys(pathParameters).length > 0) {
    return pathParameters;
  }

  // Manual extraction for common patterns
  const parts = path.split('/').filter(Boolean);

  // /checkin/{tagId}
  if (parts[0] === 'checkin' && parts.length === 2) {
    return { tagId: decodeURIComponent(parts[1]) };
  }

  // /stations/{stationId}
  if (parts[0] === 'stations' && parts.length === 2) {
    return { stationId: parts[1] };
  }

  // /missions/{missionId}/winners
  if (parts[0] === 'missions' && parts.length === 3 && parts[2] === 'winners') {
    return { missionId: decodeURIComponent(parts[1]) };
  }

  // /missions/{missionId}
  if (parts[0] === 'missions' && parts.length === 2) {
    return { missionId: decodeURIComponent(parts[1]) };
  }

  return {};
}

function extractClaims(event) {
  return event.requestContext?.authorizer?.jwt?.claims || null;
}

/**
 * Dispatches incoming API Gateway events to the appropriate handler.
 * @param {object} event - API Gateway HTTP API v2 event
 * @returns {Promise<object>} API Gateway response
 */
export async function route(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  const path = event.requestContext?.http?.path || event.path || '';
  const pathParameters = event.pathParameters || {};

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return response.noContent();
  }

  try {
    // Parse path params
    const params = extractPathParams(path, pathParameters);

    // --- Route matching ---

    // POST /checkin
    if (method === 'POST' && path === '/checkin') {
      const body = parseBody(event);
      const validation = validateCheckinRequest(body);
      if (!validation.valid) {
        if (validation.error === 'missing_field') {
          return response.missingField(validation.field);
        }
        return response.invalidField(validation.field, validation.message);
      }
      return await handleCheckin({ tagId: body.tagId.trim(), scannerId: body.scannerId.trim() });
    }

    // GET /checkin/{tagId}/rewards
    if (method === 'GET' && path.match(/^\/checkin\/[^/]+\/rewards$/)) {
      const parts = path.split('/').filter(Boolean);
      const tagId = decodeURIComponent(parts[1]);
      const validation = validateTagId(tagId);
      if (!validation.valid) {
        return response.missingField('tagId');
      }
      return await handleRewards(tagId.trim());
    }

    // GET /checkin/{tagId}
    if (method === 'GET' && path.match(/^\/checkin\/[^/]+$/)) {
      const tagId = params.tagId;
      const validation = validateTagId(tagId);
      if (!validation.valid) {
        return response.missingField('tagId');
      }
      return await handleProgress(tagId.trim());
    }

    // GET /stations (summary — must match before /stations/{id})
    if (method === 'GET' && path === '/stations') {
      return await handleStationSummary();
    }

    // GET /stations/{stationId}
    if (method === 'GET' && path.match(/^\/stations\/[^/]+$/)) {
      const stationId = params.stationId;
      const validation = validateStationId(stationId);
      if (!validation.valid) {
        return response.invalidField('stationId', 'Station identifier must be an integer between 1 and 10');
      }
      return await handleStationTraffic(Number(stationId));
    }

    // GET /leaderboard
    if (method === 'GET' && path === '/leaderboard') {
      return await handleLeaderboard();
    }

    // GET /missions/{missionId}/winners (public route — must match before /missions/{id})
    if (method === 'GET' && path.match(/^\/missions\/[^/]+\/winners$/)) {
      const missionId = params.missionId;
      if (!missionId) {
        return response.missingField('missionId');
      }
      return await handleMissionAdmin({ method, missionId, action: 'winners' });
    }

    // GET /missions/active (public route — list active missions for participants)
    if (method === 'GET' && path === '/missions/active') {
      return await handleMissionAdmin({ method, action: 'listActive' });
    }

    // POST /verify/lunch
    if (method === 'POST' && path === '/verify/lunch') {
      const body = parseBody(event);
      const claims = extractClaims(event);
      return await handleVerify({ type: 'lunch', body, claims });
    }

    // POST /verify/party
    if (method === 'POST' && path === '/verify/party') {
      const body = parseBody(event);
      const claims = extractClaims(event);
      return await handleVerify({ type: 'party', body, claims });
    }

    // POST /entitlement/set
    if (method === 'POST' && path === '/entitlement/set') {
      const body = parseBody(event);
      const claims = extractClaims(event);
      return await handleSetEntitlement({ body, claims });
    }

    // POST /entitlement/remove
    if (method === 'POST' && path === '/entitlement/remove') {
      const body = parseBody(event);
      const claims = extractClaims(event);
      return await handleRemoveEntitlement({ body, claims });
    }

    // GET /entitlement/{tagId}
    if (method === 'GET' && path.match(/^\/entitlement\/[^/]+$/)) {
      const parts = path.split('/').filter(Boolean);
      const tagId = decodeURIComponent(parts[1]);
      return await handleGetEntitlement(tagId);
    }

    // POST /rewards/redeem (admin auth required - JWT validated by API Gateway)
    if (method === 'POST' && path === '/rewards/redeem') {
      const body = parseBody(event);
      return await handleRedeemReward(body);
    }

    // Mission admin routes: POST/GET/PUT/DELETE /missions/*
    if (path.startsWith('/missions')) {
      const missionId = params.missionId || null;

      if (method === 'POST' && path === '/missions') {
        const body = parseBody(event);
        const validation = validateMissionParams(body);
        if (!validation.valid) {
          if (validation.error === 'missing_field') {
            return response.missingField(validation.field);
          }
          return response.invalidField(validation.field, validation.message);
        }
        return await handleMissionAdmin({ method, body });
      }

      if (method === 'GET' && path === '/missions') {
        return await handleMissionAdmin({ method, action: 'list' });
      }

      if (method === 'GET' && missionId) {
        return await handleMissionAdmin({ method, missionId, action: 'get' });
      }

      if (method === 'PUT' && missionId) {
        const body = parseBody(event);
        const validation = validateMissionParams(body, true);
        if (!validation.valid) {
          if (validation.error === 'missing_field') {
            return response.missingField(validation.field);
          }
          return response.invalidField(validation.field, validation.message);
        }
        return await handleMissionAdmin({ method, missionId, body });
      }

      if (method === 'DELETE' && missionId) {
        return await handleMissionAdmin({ method, missionId, action: 'delete' });
      }
    }

    // Combo routes: POST/GET /combos
    if (path === '/combos') {
      if (method === 'POST') {
        const body = parseBody(event);
        const validation = validateComboParams(body);
        if (!validation.valid) {
          if (validation.error === 'missing_field') {
            return response.missingField(validation.field);
          }
          return response.invalidField(validation.field, validation.message);
        }
        return await handleComboAdmin({ method, body });
      }

      if (method === 'GET') {
        return await handleComboAdmin({ method, action: 'list' });
      }
    }

    // --- Lottery routes ---

    // POST /lottery/nickname (public — eligibility checked in handler)
    if (method === 'POST' && path === '/lottery/nickname') {
      return await handleNicknameRegister(parseBody(event));
    }

    // GET /lottery/participants (public — accessed by lottery display)
    if (method === 'GET' && path === '/lottery/participants') {
      return await handleListParticipants();
    }

    // POST /lottery/draw (admin auth required - JWT validated by API Gateway)
    if (method === 'POST' && path === '/lottery/draw') {
      return await handleDraw(extractClaims(event), parseBody(event));
    }

    // POST /lottery/winner (admin only — manually add a winner by nickname)
    if (method === 'POST' && path === '/lottery/winner') {
      return await handleAddWinner(parseBody(event), extractClaims(event));
    }

    // POST /lottery/participant (admin only — manually add a candidate by nickname)
    if (method === 'POST' && path === '/lottery/participant') {
      return await handleAddParticipant(parseBody(event), extractClaims(event));
    }

    // GET /lottery/winners (public — lottery display page polls this)
    if (method === 'GET' && path === '/lottery/winners') {
      return await handleListWinners();
    }

    // GET /lottery/config (public — progress page reads it too)
    if (method === 'GET' && path === '/lottery/config') {
      return await handleGetLotteryConfig();
    }

    // POST /lottery/config (admin only)
    if (method === 'POST' && path === '/lottery/config') {
      const body = parseBody(event);
      return await handleSetLotteryConfig(body, extractClaims(event));
    }

    // POST /lottery/reset (admin only — clears all nicknames + winners)
    if (method === 'POST' && path === '/lottery/reset') {
      return await handleResetLottery(extractClaims(event));
    }

    // POST /lottery/winner/delete (admin only — delete winners by nickname)
    if (method === 'POST' && path === '/lottery/winner/delete') {
      return await handleDeleteWinners(parseBody(event), extractClaims(event));
    }

    // POST /admin/reset-stats (admin only — clears participant activity / statistics)
    if (method === 'POST' && path === '/admin/reset-stats') {
      return await handleResetStats(extractClaims(event));
    }

    // GET /admin/users (admin only — list staff/exhibitor accounts)
    if (method === 'GET' && path === '/admin/users') {
      return await handleListUsers(extractClaims(event));
    }

    // POST /admin/users (admin only — create staff/exhibitor account)
    if (method === 'POST' && path === '/admin/users') {
      return await handleCreateUser(parseBody(event), extractClaims(event));
    }

    // POST /admin/users/password (admin only — reset account password)
    if (method === 'POST' && path === '/admin/users/password') {
      return await handleResetUserPassword(parseBody(event), extractClaims(event));
    }

    // POST /admin/users/delete (admin only — delete account)
    if (method === 'POST' && path === '/admin/users/delete') {
      return await handleDeleteUser(parseBody(event), extractClaims(event));
    }

    // No route matched
    return response.buildErrorResponse(404, 'not_found', 'Route not found');
  } catch (err) {
    console.error('Router error:', err);
    return response.internalError('Internal server error');
  }
}
