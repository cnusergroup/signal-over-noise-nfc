/**
 * Early bird processor — awards bonus to first N visitors at a station.
 * Uses atomic counter to determine position and conditional write for slot allocation.
 * Handles idempotency: tags already awarded get their existing bonus returned.
 * Transitions mission to completed state when N winners are recorded.
 */

import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isoNow, missionTTL } from '../utils/time.mjs';

/**
 * Extracts the missionId from a mission object.
 * @param {object} mission - Mission configuration
 * @returns {string} The mission identifier
 */
function getMissionId(mission) {
  if (mission.missionId) return mission.missionId;
  if (mission.PK && mission.PK.startsWith('MISSION#')) {
    return mission.PK.slice('MISSION#'.length);
  }
  return mission.PK || 'unknown';
}

/**
 * Processes an early bird mission for a check-in.
 *
 * Flow:
 * 1. Check if tag already has an entry for this mission (idempotency)
 * 2. If already awarded: return existing bonus without re-awarding
 * 3. Atomic increment counter to determine position
 * 4. If position ≤ N: write early bird slot and entry, return bonus
 * 5. If position > N: return null (no bonus, mission full)
 * 6. If position === N: transition mission to completed state
 *
 * @param {object} mission - Mission configuration (winnerCount, bonusPoints, etc.)
 * @param {string} tagId - NFC tag identifier
 * @param {object} deps - Injected dependencies { client, tableName }
 * @returns {Promise<object|null>} Early bird result or null if slots full
 */
export async function processEarlyBird(mission, tagId, deps) {
  const { client, tableName } = deps;
  const missionId = getMissionId(mission);
  const winnerCount = mission.winnerCount;
  const bonusPoints = mission.bonusPoints;

  // 1. Check if tag already has an entry for this mission
  const existingEntry = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `MISSION#${missionId}`, SK: `ENTRY#${tagId}` },
  }));

  if (existingEntry.Item && existingEntry.Item.earlyBirdPosition) {
    // Already awarded — return existing bonus without re-awarding
    return {
      missionId,
      position: existingEntry.Item.earlyBirdPosition,
      bonusPoints,
      alreadyAwarded: true,
    };
  }

  // Calculate TTL from mission end time
  const endTimeMs = mission.endTime
    ? (typeof mission.endTime === 'string' ? new Date(mission.endTime).getTime() : mission.endTime)
    : Date.now();
  const ttl = missionTTL(endTimeMs);

  // 2. Atomic increment counter to determine position
  const counterResult = await client.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `MISSION#${missionId}`, SK: 'COUNTER' },
    UpdateExpression: 'ADD #count :inc',
    ExpressionAttributeNames: { '#count': 'count' },
    ExpressionAttributeValues: { ':inc': 1 },
    ReturnValues: 'ALL_NEW',
  }));

  const position = counterResult.Attributes.count;

  // 3. If position > N: mission full, no bonus
  if (position > winnerCount) {
    return null;
  }

  // 4. Position ≤ N: write early bird slot and entry record
  try {
    // Write the early bird slot record
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `MISSION#${missionId}`,
        SK: `EARLYBIRD#${position}`,
        tagId,
        position,
        bonusPoints,
        awardedAt: isoNow(),
        ttl,
      },
    }));

    // Write the entry record for this tag (for idempotency checks)
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `MISSION#${missionId}`,
        SK: `ENTRY#${tagId}`,
        tagId,
        earlyBirdPosition: position,
        bonusPoints,
        awardedAt: isoNow(),
        GSI1PK: `TAG#${tagId}`,
        GSI1SK: `MISSION#${missionId}`,
        ttl,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Race condition: another request wrote the entry first.
      // Re-read the entry to return the actual awarded position.
      const raceEntry = await client.send(new GetCommand({
        TableName: tableName,
        Key: { PK: `MISSION#${missionId}`, SK: `ENTRY#${tagId}` },
      }));

      if (raceEntry.Item && raceEntry.Item.earlyBirdPosition) {
        return {
          missionId,
          position: raceEntry.Item.earlyBirdPosition,
          bonusPoints,
          alreadyAwarded: true,
        };
      }
      // If somehow no position recorded, return null as safe fallback
      return null;
    }
    throw err;
  }

  // 5. If position === N: transition mission to completed state
  if (position === winnerCount) {
    try {
      await client.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
        UpdateExpression: 'SET #status = :completed, completedAt = :now, actualWinnerCount = :count',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':completed': 'completed',
          ':now': isoNow(),
          ':count': winnerCount,
        },
      }));
    } catch (err) {
      // Log but don't fail the check-in — the bonus was already awarded
      console.error(`Failed to transition mission ${missionId} to completed:`, err);
    }
  }

  return {
    missionId,
    position,
    bonusPoints,
    awarded: true,
  };
}
