/**
 * Numbered visit processor — assigns sequential visitor numbers via atomic counter.
 * Guarantees uniqueness under concurrent conditions using DynamoDB ADD.
 *
 * Flow:
 * 1. Check if tag already has an entry for this mission (idempotency)
 * 2. If not, atomically increment the mission counter
 * 3. Write entry with assigned visitor number (conditional PutItem)
 * 4. Check if visitor number matches any milestone
 * 5. Return result with visitorNumber, isMilestone, milestoneMessage
 */

import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { missionTTL } from '../utils/time.mjs';

/**
 * Extracts the missionId from a mission object.
 * Handles both raw missionId field and PK-prefixed format.
 * @param {object} mission - Mission configuration
 * @returns {string} The mission identifier (without prefix)
 */
function extractMissionId(mission) {
  if (mission.missionId) return mission.missionId;
  if (mission.PK && mission.PK.startsWith('MISSION#')) {
    return mission.PK.replace('MISSION#', '');
  }
  return mission.PK || '';
}

/**
 * Processes a numbered visit mission for a check-in.
 *
 * @param {object} mission - Mission configuration (includes missionId or PK, milestones array)
 * @param {string} tagId - NFC tag identifier
 * @param {object} deps - Injected dependencies { client, tableName }
 * @returns {Promise<object>} Result: { missionId, visitorNumber, isMilestone, milestoneMessage }
 */
export async function processNumberedVisit(mission, tagId, deps) {
  const { client, tableName } = deps;
  const missionId = extractMissionId(mission);
  const milestones = mission.milestones || [];

  // Step 1: Check if tag already has an entry for this mission (idempotency)
  const existingEntry = await client.send(new GetCommand({
    TableName: tableName,
    Key: {
      PK: `MISSION#${missionId}`,
      SK: `ENTRY#${tagId}`,
    },
  }));

  if (existingEntry.Item) {
    // Return existing visitor number without incrementing counter
    const visitorNumber = existingEntry.Item.visitorNumber;
    const isMilestone = milestones.includes(visitorNumber);
    return {
      missionId,
      visitorNumber,
      isMilestone,
      milestoneMessage: isMilestone ? `You are visitor #${visitorNumber}!` : null,
    };
  }

  // Calculate TTL from mission end time
  const endTimeMs = mission.endTime
    ? (typeof mission.endTime === 'string' ? new Date(mission.endTime).getTime() : mission.endTime)
    : Date.now();
  const ttl = missionTTL(endTimeMs);

  // Step 2: Atomic increment counter to get unique visitor number
  const counterResult = await client.send(new UpdateCommand({
    TableName: tableName,
    Key: {
      PK: `MISSION#${missionId}`,
      SK: 'COUNTER',
    },
    UpdateExpression: 'ADD visitorCount :inc',
    ExpressionAttributeValues: {
      ':inc': 1,
    },
    ReturnValues: 'ALL_NEW',
  }));

  const visitorNumber = counterResult.Attributes.visitorCount;

  // Step 3: Write entry with assigned visitor number (conditional PutItem)
  // Condition ensures at-most-once write per tag per mission
  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `MISSION#${missionId}`,
        SK: `ENTRY#${tagId}`,
        visitorNumber,
        tagId,
        missionId,
        GSI1PK: `TAG#${tagId}`,
        GSI1SK: `MISSION#${missionId}`,
        ttl,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err) {
    // ConditionalCheckFailedException means another concurrent request already wrote the entry.
    // In that case, read the existing entry and return its visitor number.
    if (err.name === 'ConditionalCheckFailedException') {
      const retryGet = await client.send(new GetCommand({
        TableName: tableName,
        Key: {
          PK: `MISSION#${missionId}`,
          SK: `ENTRY#${tagId}`,
        },
      }));
      if (retryGet.Item) {
        const existingNumber = retryGet.Item.visitorNumber;
        const isMilestone = milestones.includes(existingNumber);
        return {
          missionId,
          visitorNumber: existingNumber,
          isMilestone,
          milestoneMessage: isMilestone ? `You are visitor #${existingNumber}!` : null,
        };
      }
    }
    // Re-throw unexpected errors
    throw err;
  }

  // Step 4: Check if visitor number matches any milestone
  const isMilestone = milestones.includes(visitorNumber);
  const milestoneMessage = isMilestone ? `You are visitor #${visitorNumber}!` : null;

  // Step 5: Return result
  return {
    missionId,
    visitorNumber,
    isMilestone,
    milestoneMessage,
  };
}
