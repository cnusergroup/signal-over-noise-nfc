/**
 * Lucky draw recorder — records eligible entries during active draw missions.
 * One entry per tag per mission, enforced via conditional PutItem.
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { isoNow, missionTTL } from '../utils/time.mjs';

/**
 * Extracts the missionId from a mission object.
 * The mission may have a missionId field directly, or it can be derived from PK (e.g. 'MISSION#m1').
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
 * Records a lucky draw entry for a check-in.
 * Uses conditional PutItem to ensure one entry per tag per mission.
 *
 * @param {object} mission - Mission configuration record
 * @param {string} tagId - NFC tag identifier
 * @param {object} deps - Injected dependencies { client, tableName }
 * @returns {Promise<{ entered: boolean, alreadyEntered: boolean }>} Entry acknowledgment
 */
export async function recordLuckyDrawEntry(mission, tagId, deps) {
  const { client, tableName } = deps;
  const missionId = getMissionId(mission);

  // Calculate TTL from mission end time (if available), otherwise use entry time + 30 days
  const endTimeMs = mission.endTime
    ? (typeof mission.endTime === 'string' ? new Date(mission.endTime).getTime() : mission.endTime)
    : Date.now();
  const ttl = missionTTL(endTimeMs);

  const item = {
    PK: `MISSION#${missionId}`,
    SK: `ENTRY#${tagId}`,
    tagId,
    enteredAt: isoNow(),
    GSI1PK: `TAG#${tagId}`,
    GSI1SK: `MISSION#${missionId}`,
    ttl,
  };

  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    return { entered: true, alreadyEntered: false };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { entered: true, alreadyEntered: true };
    }
    throw err;
  }
}
