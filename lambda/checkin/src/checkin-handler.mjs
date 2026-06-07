/**
 * Check-in handler — processes NFC check-in requests.
 * Validates tag, resolves scanner to station, enforces cooldown, records check-in.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, buildKey } from './utils/dynamo.mjs';
import { now, isoNow, checkinTTL, toISO, isAfterPartyCheckin } from './utils/time.mjs';
import { ok, missingField, notFound, cooldown, internalError, invalidField } from './utils/response.mjs';
import { evaluateMissions } from './mission-engine/evaluator.mjs';

const COOLDOWN_SECONDS = 30;

/**
 * Handles POST /checkin requests.
 * @param {object} body - Parsed request body with tagId and scannerId
 * @returns {Promise<object>} API Gateway response object
 */
export async function handleCheckin(body) {
  // 1. Validate required fields
  if (!body || !body.tagId || (typeof body.tagId === 'string' && body.tagId.trim() === '')) {
    return missingField('tagId');
  }
  if (!body.scannerId || (typeof body.scannerId === 'string' && body.scannerId.trim() === '')) {
    return missingField('scannerId');
  }

  const { tagId, scannerId } = body;
  const client = getDocClient();
  const tableName = getTableName();

  // 2. Look up scanner-to-station mapping
  let scannerRecord;
  try {
    const scannerResult = await client.send(new GetCommand({
      TableName: tableName,
      Key: buildKey(`SCANNER#${scannerId}`, 'CONFIG'),
    }));
    scannerRecord = scannerResult.Item;
  } catch (err) {
    console.error('DynamoDB error looking up scanner:', err);
    return internalError('Failed to look up scanner mapping');
  }

  if (!scannerRecord || !scannerRecord.stationId) {
    return invalidField('scannerId', 'Unrecognized scanner identifier');
  }

  const stationId = scannerRecord.stationId;

  // 3. Validate NFC tag exists in registry
  let tagRecord;
  try {
    const tagResult = await client.send(new GetCommand({
      TableName: tableName,
      Key: buildKey(`TAG#${tagId}`, 'REGISTRY'),
    }));
    tagRecord = tagResult.Item;
  } catch (err) {
    console.error('DynamoDB error looking up tag:', err);
    return internalError('Failed to validate NFC tag');
  }

  if (!tagRecord) {
    return notFound('Unrecognized NFC tag');
  }

  // 4. Check existing check-in record for cooldown
  let existingCheckin;
  try {
    const checkinResult = await client.send(new GetCommand({
      TableName: tableName,
      Key: buildKey(`TAG#${tagId}`, `CHECKIN#${stationId}`),
    }));
    existingCheckin = checkinResult.Item;
  } catch (err) {
    console.error('DynamoDB error checking existing check-in:', err);
    return internalError('Failed to check existing check-in');
  }

  const currentTime = now();

  // 5. Evaluate cooldown
  if (existingCheckin && existingCheckin.checkinTime) {
    const lastCheckinMs = typeof existingCheckin.checkinTime === 'string'
      ? new Date(existingCheckin.checkinTime).getTime()
      : existingCheckin.checkinTime;
    const elapsedSeconds = Math.floor((currentTime - lastCheckinMs) / 1000);

    if (elapsedSeconds < COOLDOWN_SECONDS) {
      const remainingSeconds = COOLDOWN_SECONDS - elapsedSeconds;

      // Evaluate missions even during cooldown (Requirement 1.5)
      const missions = await evaluateMissions({
        tagId,
        stationId,
        checkinTime: existingCheckin.checkinTime,
        isNewCheckin: false,
      });

      return cooldown(remainingSeconds, missions);
    }
  }

  // 6. First visit or cooldown expired — write new check-in record
  const checkinTime = toISO(currentTime);
  const ttl = checkinTTL(currentTime);
  const isAfterParty = isAfterPartyCheckin(currentTime);

  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...buildKey(`TAG#${tagId}`, `CHECKIN#${stationId}`),
        GSI1PK: `STATION#${stationId}`,
        GSI1SK: `CHECKIN#${checkinTime}`,
        tagId,
        stationId,
        checkinTime,
        afterParty: isAfterParty,
        ttl,
      },
    }));

    // If this check-in is after the After Party time gate, also write/update
    // a dedicated AFTER_PARTY record. This is the authoritative "入场打卡" for
    // lottery eligibility — separate from regular station check-ins.
    if (isAfterParty) {
      await client.send(new PutCommand({
        TableName: tableName,
        Item: {
          ...buildKey(`TAG#${tagId}`, 'AFTER_PARTY'),
          tagId,
          checkinTime,
          stationId,
        },
      }));
    }
  } catch (err) {
    console.error('DynamoDB error writing check-in record:', err);
    return internalError('Failed to record check-in');
  }

  // 7. Evaluate missions after successful check-in
  const missions = await evaluateMissions({
    tagId,
    stationId,
    checkinTime,
    isNewCheckin: true,
  });

  // 8. Return success response
  return ok({
    success: true,
    tagId,
    stationId,
    checkinTime,
    missions,
  });
}
