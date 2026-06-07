/**
 * Stamp rally evaluator — checks if all 10 stations have been visited.
 * Generates a cryptographically secure reward code on first completion.
 * Handles race conditions via conditional PutItem.
 */

import { QueryCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { generateRewardCode } from '../utils/crypto.mjs';
import { filterExpired } from '../utils/time.mjs';
import { updateLeaderboard } from '../leaderboard-handler.mjs';

const TOTAL_STATIONS = 10;

/**
 * Evaluates stamp rally completion for a given tag.
 *
 * Steps:
 * 1. Query all check-ins for the tag (PK=TAG#{tagId}, SK begins_with CHECKIN#)
 * 2. Filter expired records (TTL < current time)
 * 3. Count unique stations visited
 * 4. If all 10 stations visited:
 *    a. Check if stamp rally record already exists
 *    b. If exists: return existing reward code
 *    c. If not: generate reward code, write record with conditional put
 *    d. Handle ConditionalCheckFailedException (race condition)
 * 5. If not all 10: return { completed: false, rewardCode: null }
 *
 * @param {string} tagId - NFC tag identifier
 * @param {object} deps - Injected dependencies
 * @param {object} deps.client - DynamoDB DocumentClient
 * @param {string} deps.tableName - DynamoDB table name
 * @returns {Promise<{ completed: boolean, rewardCode: string|null }>}
 */
export async function evaluateStampRally(tagId, deps) {
  const { client, tableName } = deps;

  // 1. Query all check-ins for this tag
  const queryResult = await client.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `TAG#${tagId}`,
      ':skPrefix': 'CHECKIN#',
    },
  }));

  const allCheckins = queryResult.Items || [];

  // 2. Filter expired records
  const validCheckins = filterExpired(allCheckins);

  // 3. Count unique stations visited
  const visitedStations = new Set();
  for (const checkin of validCheckins) {
    // SK format is CHECKIN#{stationId}
    const sk = checkin.SK;
    if (sk) {
      const stationId = sk.replace('CHECKIN#', '');
      visitedStations.add(stationId);
    }
  }

  // 5. If not all 10 stations visited, return incomplete
  if (visitedStations.size < TOTAL_STATIONS) {
    return { completed: false, rewardCode: null };
  }

  // 4. All 10 stations visited — check for existing stamp rally record
  const existingResult = await client.send(new GetCommand({
    TableName: tableName,
    Key: {
      PK: `TAG#${tagId}`,
      SK: 'STAMPRALLY',
    },
  }));

  // 4b. If already exists, return existing reward code
  if (existingResult.Item) {
    return {
      completed: true,
      rewardCode: existingResult.Item.rewardCode,
    };
  }

  // 4c. Generate new reward code and write stamp rally record
  const rewardCode = generateRewardCode();
  const completedAt = new Date().toISOString();

  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `TAG#${tagId}`,
        SK: 'STAMPRALLY',
        rewardCode,
        completedAt,
        tagId,
      },
      // 4d. Conditional write to handle race conditions
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    // Update leaderboard with elapsed time
    try {
      const timestamps = validCheckins.map(c => c.checkinTime).filter(Boolean);
      await updateLeaderboard(tagId, timestamps, deps);
    } catch (e) {
      console.error('Leaderboard update failed (non-fatal):', e);
    }

    return { completed: true, rewardCode };
  } catch (err) {
    // 4e. Handle ConditionalCheckFailedException — another request won the race
    if (err.name === 'ConditionalCheckFailedException') {
      // Re-read and return the existing record
      const raceResult = await client.send(new GetCommand({
        TableName: tableName,
        Key: {
          PK: `TAG#${tagId}`,
          SK: 'STAMPRALLY',
        },
      }));

      if (raceResult.Item) {
        return {
          completed: true,
          rewardCode: raceResult.Item.rewardCode,
        };
      }
    }

    // Re-throw unexpected errors
    throw err;
  }
}
