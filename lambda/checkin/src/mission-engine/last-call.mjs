/**
 * Last call recorder — maintains sliding window of recent visitors.
 * Each check-in overwrites the previous entry for the same tag, keeping only the latest timestamp.
 * Winners are determined at mission end time by EventBridge-triggered Lambda.
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
 * Records a last call entry for a check-in.
 * Uses PutItem (upsert) to overwrite any previous entry for the same tag,
 * keeping only the latest check-in timestamp. This maintains the sliding window
 * so that at mission end time, the most recent N unique visitors can be selected as winners.
 *
 * @param {object} mission - Mission configuration record
 * @param {string} tagId - NFC tag identifier
 * @param {string} checkinTime - Check-in timestamp (ISO 8601)
 * @param {object} deps - Injected dependencies { client, tableName }
 * @returns {Promise<{ entered: true }>} Entry acknowledgment
 */
export async function recordLastCallEntry(mission, tagId, checkinTime, deps) {
  const { client, tableName } = deps;
  const missionId = getMissionId(mission);

  // Calculate TTL from mission end time
  const endTimeMs = mission.endTime
    ? (typeof mission.endTime === 'string' ? new Date(mission.endTime).getTime() : mission.endTime)
    : Date.now();
  const ttl = missionTTL(endTimeMs);

  const item = {
    PK: `MISSION#${missionId}`,
    SK: `LASTCALL#${tagId}`,
    tagId,
    checkinTime,
    updatedAt: isoNow(),
    ttl,
  };

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  return { entered: true };
}
