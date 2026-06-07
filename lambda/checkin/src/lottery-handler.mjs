/**
 * Lottery handler — After Party lottery endpoints.
 *
 * This module hosts the lottery-related request handlers that back the
 * After Party Lottery feature. It reuses the single `CheckinHandler` Lambda
 * and the single DynamoDB table.
 *
 * Handlers:
 *   - handleNicknameRegister(body)  POST /lottery/nickname     (task: 4.2)
 *   - handleListParticipants()      GET  /lottery/participants  (task: 5.1)
 *   - handleDraw(claims)            POST /lottery/draw          (task: 5.2)
 *   - handleListWinners(claims)     GET  /lottery/winners       (task: 5.3)
 */

import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomInt } from 'node:crypto';
import { getDocClient, getTableName, buildKey, buildKeyCondition, buildGSIKeyCondition } from './utils/dynamo.mjs';
import { now, isoNow, getAfterPartyTimeGateMs, setTimeGateOverride, filterExpired } from './utils/time.mjs';
import { ok, error, internalError, missingField } from './utils/response.mjs';
import { validateNickname } from './validator.mjs';

/** Number of distinct stations required for stamp-rally completion. */
const TOTAL_STATIONS = 10;

/**
 * Handles POST /lottery/nickname requests.
 *
 * Registers a unique nickname for a lottery-eligible tag. Eligibility requires
 * that the tag has check-ins at all 10 distinct stations AND at least one
 * check-in recorded at or after the After Party time gate. Uniqueness is
 * enforced atomically via a two-item conditional transaction.
 *
 * @param {object} body - Parsed request body: { tagId, nickname }
 * @returns {Promise<object>} API Gateway response object
 */
export async function handleNicknameRegister(body) {
  // 1. Validate request body shape.
  if (!body || typeof body.tagId !== 'string' || body.tagId.trim() === '') {
    return missingField('tagId');
  }
  const tagId = body.tagId;

  const nickResult = validateNickname(body.nickname);
  if (!nickResult.ok) {
    return error(400, nickResult.code, nickResult.message, 'nickname');
  }
  const nickname = body.nickname;

  // 2. Time-gate check — the lottery is not open before the gate.
  //    Reload config from DynamoDB so admin-set time is always fresh.
  await loadLotteryConfig();
  if (now() < getAfterPartyTimeGateMs()) {
    return error(403, 'lottery_not_open', 'Nickname registration is not yet available');
  }

  const client = getDocClient();
  const tableName = getTableName();

  // 3. Eligibility check — query all check-ins for the tag.
  let checkinItems;
  try {
    const keyCondition = buildKeyCondition(`TAG#${tagId}`, { beginsWith: 'CHECKIN#' });
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      ...keyCondition,
    }));
    checkinItems = result.Items || [];
  } catch (err) {
    console.error('DynamoDB error querying check-ins for eligibility:', err);
    return internalError('Failed to verify lottery eligibility');
  }

  // Exclude expired records before counting (mirrors progress-handler).
  const validCheckins = filterExpired(checkinItems);
  const distinctStations = new Set(validCheckins.map(item => item.stationId));

  // Check for the dedicated AFTER_PARTY record (written on any check-in after the gate).
  let hasAfterPartyCheckin = false;
  try {
    const apResult = await client.send(new GetCommand({
      TableName: tableName,
      Key: buildKey(`TAG#${tagId}`, 'AFTER_PARTY'),
    }));
    hasAfterPartyCheckin = !!apResult.Item;
  } catch (err) {
    console.error('DynamoDB error checking AFTER_PARTY record:', err);
  }

  if (distinctStations.size < TOTAL_STATIONS || !hasAfterPartyCheckin) {
    return error(403, 'not_eligible', 'Tag does not meet lottery eligibility requirements');
  }

  // 4. Atomic uniqueness write — two conditional Puts in a single transaction.
  //    Item 0: TAG#{tagId}/NICKNAME      — one nickname per tag.
  //    Item 1: NICKNAME#{nickname}/RESERVED — global uniqueness + list index.
  const registeredAt = isoNow();

  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              ...buildKey(`TAG#${tagId}`, 'NICKNAME'),
              tagId,
              nickname,
              registeredAt,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              ...buildKey(`NICKNAME#${nickname}`, 'RESERVED'),
              GSI1PK: 'NICKNAME_LIST',
              GSI1SK: nickname,
              tagId,
              nickname,
              registeredAt,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }));
  } catch (err) {
    // 5. Map a canceled transaction to the specific 409 conflict.
    if (err && err.name === 'TransactionCanceledException') {
      const reasons = err.CancellationReasons || [];
      if (reasons[0] && reasons[0].Code === 'ConditionalCheckFailed') {
        return error(409, 'already_registered', 'A nickname has already been registered for this tag');
      }
      if (reasons[1] && reasons[1].Code === 'ConditionalCheckFailed') {
        return error(409, 'nickname_taken', 'Nickname is already taken');
      }
    }
    console.error('DynamoDB error registering nickname:', err);
    return internalError('Failed to register nickname');
  }

  // 6. Success.
  return ok({ tagId, nickname, registeredAt });
}

/**
 * Handles GET /lottery/participants requests.
 *
 * Returns every registered lottery participant by enumerating the reserved
 * nickname records via GSI1 (`GSI1PK = 'NICKNAME_LIST'`). Each participant's
 * eligibility was confirmed at registration time and cannot regress (check-in
 * records are never deleted), so the reserved-nickname set is the participant
 * list. Only the `nickname` is returned — `tagId` is intentionally omitted to
 * preserve attendee privacy.
 *
 * This endpoint requires no authentication; it is consumed by the lottery
 * display system, which holds no credentials.
 *
 * @returns {Promise<object>} API Gateway response object:
 *   200 { count, participants: [{ nickname }, ...] } on success,
 *   500 internal_error on any DynamoDB failure.
 */
export async function handleListParticipants() {
  const client = getDocClient();
  const tableName = getTableName();

  let items;
  try {
    const gsiCondition = buildGSIKeyCondition('GSI1', 'NICKNAME_LIST');
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      ...gsiCondition,
    }));
    items = result.Items || [];
  } catch (err) {
    console.error('DynamoDB error listing lottery participants:', err);
    return internalError('Failed to retrieve participant list');
  }

  const participants = items.map(item => ({ nickname: item.nickname }));

  return ok({ count: participants.length, participants });
}

/**
 * Returns true if the JWT claims indicate `admin` group membership.
 *
 * The API Gateway JWT authorizer already enforces token validity (returning
 * 401 for a missing or invalid token), so this check only needs to confirm
 * group membership. Cognito may surface `cognito:groups` as a real array, or
 * as a bracketed/comma-separated string (e.g. "[admin, staff]" or "admin"),
 * so both shapes are normalized — mirroring the convention in verify-handler.
 *
 * @param {object|null} claims - JWT claims from the API Gateway authorizer
 * @returns {boolean} True if the caller belongs to the `admin` group
 */
function isAdmin(claims) {
  if (!claims) return false;
  const groups = claims['cognito:groups'];
  if (!groups) return false;
  let groupList;
  if (Array.isArray(groups)) {
    groupList = groups;
  } else if (typeof groups === 'string') {
    // Cognito may return "[admin, staff]" or "[admin]" or "admin".
    const cleaned = groups.replace(/^\[|\]$/g, '').trim();
    groupList = cleaned ? cleaned.split(/\s*,\s*/) : [];
  } else {
    groupList = [];
  }
  return groupList.includes('admin');
}

/**
 * Queries all registered lottery participants via GSI1.
 *
 * Uses the same GSI1 query (`GSI1PK = 'NICKNAME_LIST'`) as
 * {@link handleListParticipants}. Unlike that public handler, the raw items
 * are returned here so the draw can read the winner's bound `tagId` (which the
 * public participants endpoint strips for privacy).
 *
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} client
 * @param {string} tableName
 * @returns {Promise<Array<object>>} Raw reserved-nickname items
 */
async function queryRegisteredParticipants(client, tableName) {
  const gsiCondition = buildGSIKeyCondition('GSI1', 'NICKNAME_LIST');
  const result = await client.send(new QueryCommand({
    TableName: tableName,
    ...gsiCondition,
  }));
  return result.Items || [];
}

/**
 * Handles POST /lottery/draw requests (admin-only).
 *
 * Randomly selects one winner from the full pool of registered participants
 * using a cryptographically secure RNG, allocates a unique monotonic draw
 * sequence number via an atomic counter increment, persists the result, and
 * returns the winner. Multiple draws are permitted and each draws from the
 * full pool (including previous winners), per Requirement 5.4.
 *
 * @param {object|null} claims - JWT claims from the API Gateway authorizer
 * @returns {Promise<object>} API Gateway response object:
 *   200 { drawSeq, nickname, tagId, drawnAt } on success,
 *   403 forbidden when the caller is not in the `admin` group,
 *   400 no_participants when the participant pool is empty,
 *   500 internal_error on any DynamoDB failure.
 */
export async function handleDraw(claims) {
  // 1. Authorization — admin group membership required. (API Gateway already
  //    enforces 401 for a missing/invalid token.)
  if (!isAdmin(claims)) {
    return error(403, 'forbidden', 'Admin group membership required');
  }

  const client = getDocClient();
  const tableName = getTableName();

  // 2. Load the current participant pool (same GSI1 query as the list endpoint).
  let participants;
  try {
    participants = await queryRegisteredParticipants(client, tableName);
  } catch (err) {
    console.error('DynamoDB error loading participants for draw:', err);
    return internalError('Failed to load lottery participants');
  }

  // 3. No participants → 400.
  if (participants.length === 0) {
    return error(400, 'no_participants', 'There are no eligible participants for the draw');
  }

  try {
    // 4. Atomic draw-sequence allocation — guarantees a unique, monotonic
    //    sequence number even under concurrent draw requests.
    const counterResult = await client.send(new UpdateCommand({
      TableName: tableName,
      Key: buildKey('LOTTERY', 'DRAW_COUNTER'),
      UpdateExpression: 'ADD seq :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }));
    const drawSeq = counterResult.Attributes.seq;

    // 5. Cryptographically secure winner selection.
    const idx = randomInt(0, participants.length);
    const winner = participants[idx];
    const nickname = winner.nickname;
    const tagId = winner.tagId;
    const drawnAt = isoNow();

    // 6. Persist the winner. The zero-padded sequence in the SK keeps winners
    //    sorting chronologically as strings (e.g. "WINNER#000003").
    const paddedSeq = String(drawSeq).padStart(6, '0');
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...buildKey('LOTTERY', `WINNER#${paddedSeq}`),
        drawSeq,
        nickname,
        tagId,
        drawnAt,
      },
    }));

    // 7. Success.
    return ok({ drawSeq, nickname, tagId, drawnAt });
  } catch (err) {
    console.error('DynamoDB error executing lottery draw:', err);
    return internalError('Failed to execute lottery draw');
  }
}

/**
 * Handles GET /lottery/winners requests (admin-only).
 *
 * Returns every recorded draw winner in chronological order. Winners are
 * stored under `PK = 'LOTTERY'`, `SK = 'WINNER#{paddedSeq}'` with a
 * zero-padded sequence number, so a Query with `ScanIndexForward: true`
 * returns them in ascending SK order — which equals chronological draw order.
 *
 * @param {object|null} claims - JWT claims from the API Gateway authorizer
 * @returns {Promise<object>} API Gateway response object:
 *   200 { count, winners: [{ drawSeq, nickname, tagId, drawnAt }, ...] } on success,
 *   403 forbidden when the caller is not in the `admin` group,
 *   500 internal_error on any DynamoDB failure.
 */
export async function handleListWinners() {
  const client = getDocClient();
  const tableName = getTableName();

  // 2. Query all winner records under PK='LOTTERY', SK begins_with 'WINNER#'.
  //    ScanIndexForward: true yields ascending SK order (chronological by the
  //    zero-padded draw sequence number).
  let items;
  try {
    const keyCondition = buildKeyCondition('LOTTERY', { beginsWith: 'WINNER#' });
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      ...keyCondition,
      ScanIndexForward: true,
    }));
    items = result.Items || [];
  } catch (err) {
    console.error('DynamoDB error listing lottery winners:', err);
    return internalError('Failed to retrieve winners list');
  }

  // 3. Project each record to the public winner shape.
  const winners = items.map(item => ({
    drawSeq: item.drawSeq,
    nickname: item.nickname,
    tagId: item.tagId,
    drawnAt: item.drawnAt,
  }));

  return ok({ count: winners.length, winners });
}


// ========================================
// Lottery Config (admin-settable time gate + total winners)
// ========================================

const CONFIG_PK = 'CONFIG';
const CONFIG_SK = 'LOTTERY_SETTINGS';

/**
 * GET /lottery/config — read current lottery settings.
 * Public (no auth required) so the progress page can also read the time gate.
 */
export async function handleGetLotteryConfig() {
  const client = getDocClient();
  const tableName = getTableName();
  try {
    const res = await client.send(new GetCommand({
      TableName: tableName,
      Key: buildKey(CONFIG_PK, CONFIG_SK),
    }));
    const item = res.Item || {};
    return ok({
      afterPartyTime: item.afterPartyTime || null,
      totalWinners: item.totalWinners || 5,
    });
  } catch (err) {
    console.error('Error reading lottery config:', err);
    return internalError('Failed to read lottery config');
  }
}

/**
 * POST /lottery/config — save lottery settings (admin only).
 * Body: { afterPartyTime: "ISO 8601 string", totalWinners: number }
 */
export async function handleSetLotteryConfig(body, claims) {
  if (!isAdmin(claims)) {
    return error(403, 'forbidden', 'Admin group membership required');
  }

  const afterPartyTime = body && body.afterPartyTime;
  const totalWinners = body && body.totalWinners;

  if (afterPartyTime) {
    const ms = Date.parse(afterPartyTime);
    if (Number.isNaN(ms)) {
      return error(400, 'invalid_field', 'afterPartyTime must be a valid ISO 8601 date');
    }
    // Update the in-memory time gate override so it takes effect immediately.
    setTimeGateOverride(ms);
  }

  const client = getDocClient();
  const tableName = getTableName();
  try {
    const item = {
      ...buildKey(CONFIG_PK, CONFIG_SK),
      ...(afterPartyTime ? { afterPartyTime } : {}),
      ...(totalWinners != null ? { totalWinners: Number(totalWinners) } : {}),
      updatedAt: isoNow(),
    };
    await client.send(new PutCommand({ TableName: tableName, Item: item }));
    return ok({ saved: true, afterPartyTime, totalWinners });
  } catch (err) {
    console.error('Error saving lottery config:', err);
    return internalError('Failed to save lottery config');
  }
}

/**
 * Load lottery config from DynamoDB on cold start and apply the time gate override.
 * Called once during Lambda init (from the router or index).
 */
export async function loadLotteryConfig() {
  try {
    const client = getDocClient();
    const tableName = getTableName();
    const res = await client.send(new GetCommand({
      TableName: tableName,
      Key: buildKey(CONFIG_PK, CONFIG_SK),
    }));
    if (res.Item && res.Item.afterPartyTime) {
      const ms = Date.parse(res.Item.afterPartyTime);
      if (!Number.isNaN(ms)) {
        setTimeGateOverride(ms);
      }
    }
  } catch (err) {
    console.error('Error loading lottery config on init:', err);
    // Non-fatal: fall back to env var default.
  }
}


/**
 * POST /lottery/reset — delete all registered nicknames, winners, and the draw counter.
 * Admin only. Used to reset the lottery for a fresh round.
 */
export async function handleResetLottery(claims) {
  if (!isAdmin(claims)) {
    return error(403, 'forbidden', 'Admin group membership required');
  }

  const client = getDocClient();
  const tableName = getTableName();
  let deleted = 0;

  try {
    // 1. Delete all NICKNAME reservations (GSI1PK = NICKNAME_LIST)
    const gsiCondition = buildGSIKeyCondition('GSI1', 'NICKNAME_LIST');
    const nickRes = await client.send(new QueryCommand({ TableName: tableName, ...gsiCondition }));
    for (const item of (nickRes.Items || [])) {
      // Delete the reservation record
      await client.send(new (await import('@aws-sdk/lib-dynamodb')).DeleteCommand({
        TableName: tableName, Key: { PK: item.PK, SK: item.SK },
      }));
      // Also delete the TAG#{tagId}/NICKNAME binding
      if (item.tagId) {
        await client.send(new (await import('@aws-sdk/lib-dynamodb')).DeleteCommand({
          TableName: tableName, Key: { PK: `TAG#${item.tagId}`, SK: 'NICKNAME' },
        }));
      }
      deleted++;
    }

    // 2. Delete all winners (PK=LOTTERY, SK begins_with WINNER#)
    const winCondition = buildKeyCondition('LOTTERY', { beginsWith: 'WINNER#' });
    const winRes = await client.send(new QueryCommand({ TableName: tableName, ...winCondition }));
    for (const item of (winRes.Items || [])) {
      await client.send(new (await import('@aws-sdk/lib-dynamodb')).DeleteCommand({
        TableName: tableName, Key: { PK: item.PK, SK: item.SK },
      }));
      deleted++;
    }

    // 3. Delete the draw counter
    try {
      await client.send(new (await import('@aws-sdk/lib-dynamodb')).DeleteCommand({
        TableName: tableName, Key: buildKey('LOTTERY', 'DRAW_COUNTER'),
      }));
      deleted++;
    } catch {}

    return ok({ reset: true, deletedItems: deleted });
  } catch (err) {
    console.error('Error resetting lottery:', err);
    return internalError('Failed to reset lottery');
  }
}


/**
 * POST /lottery/winner — manually add a winner by nickname (admin only).
 *
 * Lets an admin push a specific person onto the winners list without running a
 * random draw. Allocates the same atomic, monotonic draw sequence used by the
 * random draw so the big-screen poll picks it up and reveals it. The nickname
 * is taken verbatim from the request (it does not need to be a registered
 * participant). The bound tagId is looked up from the reserved-nickname record
 * when available, otherwise stored as null.
 *
 * Body: { nickname: string }
 * @param {object} body
 * @param {object|null} claims - JWT claims from the authorizer
 * @returns {Promise<object>} 200 { drawSeq, nickname, tagId, drawnAt } on success.
 */
export async function handleAddWinner(body, claims) {
  if (!isAdmin(claims)) {
    return error(403, 'forbidden', 'Admin group membership required');
  }

  const nickname = body && typeof body.nickname === 'string' ? body.nickname.trim() : '';
  if (!nickname) {
    return missingField('nickname');
  }

  const client = getDocClient();
  const tableName = getTableName();

  try {
    // Best-effort: resolve the bound tagId from the reserved-nickname record.
    let tagId = null;
    try {
      const res = await client.send(new GetCommand({
        TableName: tableName,
        Key: buildKey(`NICKNAME#${nickname}`, 'RESERVED'),
      }));
      if (res.Item && res.Item.tagId) tagId = res.Item.tagId;
    } catch { /* ignore lookup failures; tagId stays null */ }

    // Atomic draw-sequence allocation (shared with the random draw).
    const counterResult = await client.send(new UpdateCommand({
      TableName: tableName,
      Key: buildKey('LOTTERY', 'DRAW_COUNTER'),
      UpdateExpression: 'ADD seq :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }));
    const drawSeq = counterResult.Attributes.seq;
    const drawnAt = isoNow();

    const paddedSeq = String(drawSeq).padStart(6, '0');
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...buildKey('LOTTERY', `WINNER#${paddedSeq}`),
        drawSeq,
        nickname,
        tagId,
        drawnAt,
        manual: true,
      },
    }));

    return ok({ drawSeq, nickname, tagId, drawnAt, manual: true });
  } catch (err) {
    console.error('DynamoDB error adding manual winner:', err);
    return internalError('Failed to add winner');
  }
}


/**
 * POST /lottery/participant — manually add a lottery candidate by nickname (admin only).
 *
 * Registers a nickname directly into the participant pool without requiring an
 * eligible tag or stamp-rally completion. The candidate then appears on the
 * big-screen sphere and is included in random draws. A synthetic tagId
 * (`manual-{slug}`) is generated so the record matches the normal participant
 * shape (the participants list strips tagId for privacy anyway).
 *
 * Body: { nickname: string }
 * @param {object} body
 * @param {object|null} claims - JWT claims from the authorizer
 * @returns {Promise<object>} 200 { nickname, tagId, registeredAt } on success,
 *   409 nickname_taken when the nickname already exists.
 */
export async function handleAddParticipant(body, claims) {
  if (!isAdmin(claims)) {
    return error(403, 'forbidden', 'Admin group membership required');
  }

  const nickname = body && typeof body.nickname === 'string' ? body.nickname.trim() : '';
  if (!nickname) {
    return missingField('nickname');
  }

  const client = getDocClient();
  const tableName = getTableName();
  const registeredAt = isoNow();
  // Synthetic tag id for manually-added candidates (no physical NFC tag).
  const tagId = 'manual-' + Date.now().toString(36) + '-' + randomInt(1000, 9999);

  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...buildKey(`NICKNAME#${nickname}`, 'RESERVED'),
        GSI1PK: 'NICKNAME_LIST',
        GSI1SK: nickname,
        tagId,
        nickname,
        registeredAt,
        manual: true,
      },
      // Reject duplicates so the same nickname isn't added twice.
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return ok({ nickname, tagId, registeredAt, manual: true });
  } catch (err) {
    if (err && err.name === 'ConditionalCheckFailedException') {
      return error(409, 'nickname_taken', 'Nickname is already registered');
    }
    console.error('DynamoDB error adding manual participant:', err);
    return internalError('Failed to add participant');
  }
}
