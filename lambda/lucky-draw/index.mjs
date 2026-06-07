/**
 * Lucky Draw Winner Selection Lambda
 *
 * Triggered by EventBridge Scheduler at mission end time.
 * Queries all eligible entries for a Lucky Draw mission,
 * randomly selects N winners using crypto-secure randomness (crypto.randomInt),
 * writes winner records, and updates mission status to completed.
 *
 * Handles the case where fewer than N entries exist by selecting all as winners.
 */

import { randomInt } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE_NAME = process.env.TABLE_NAME;

export const handler = async (event) => {
  console.log('Lucky Draw Lambda invoked', JSON.stringify(event));

  const { missionId } = event;

  if (!missionId) {
    console.error('Missing missionId in event payload');
    return { statusCode: 400, body: 'Missing missionId' };
  }

  try {
    // 1. Get mission config to determine winnerCount (N) and prizeDescription
    const configResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
    }));

    if (!configResult.Item) {
      console.error(`Mission config not found for ${missionId}`);
      return { statusCode: 404, body: `Mission ${missionId} not found` };
    }

    const missionConfig = configResult.Item;
    const winnerCount = missionConfig.winnerCount || 1;
    const prizeDescription = missionConfig.prizeDescription || '';

    // Calculate TTL from mission end time (endTime + 30 days)
    const endTimeMs = missionConfig.endTime
      ? (typeof missionConfig.endTime === 'string' ? new Date(missionConfig.endTime).getTime() : missionConfig.endTime)
      : Date.now();
    const ttl = Math.floor(endTimeMs / 1000) + 30 * 24 * 60 * 60;

    console.log(`Mission ${missionId}: selecting up to ${winnerCount} winners`);

    // 2. Query all eligible entries for this mission (handle pagination)
    const entries = await queryAllEntries(missionId);

    console.log(`Mission ${missionId}: found ${entries.length} eligible entries`);

    // 3. Randomly select N winners using Fisher-Yates shuffle with crypto.randomInt
    //    Handle case where entries < N by selecting all
    const winnersToSelect = Math.min(winnerCount, entries.length);
    const winners = selectRandomWinners(entries, winnersToSelect);

    console.log(`Mission ${missionId}: selected ${winnersToSelect} winners`);

    // 4. Write winner records
    for (const winner of winners) {
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `MISSION#${missionId}`,
          SK: `WINNER#${winner.tagId}`,
          tagId: winner.tagId,
          prizeDescription,
          awardedAt: new Date().toISOString(),
          ttl,
        },
      }));
    }

    // 5. Update mission status to 'completed' with actualWinnerCount
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
      UpdateExpression: 'SET #status = :status, completedAt = :completedAt, actualWinnerCount = :actualWinnerCount',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'completed',
        ':completedAt': new Date().toISOString(),
        ':actualWinnerCount': winnersToSelect,
      },
    }));

    console.log(`Mission ${missionId}: selection complete with ${winnersToSelect} winners`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        missionId,
        winnersSelected: winnersToSelect,
        totalEntries: entries.length,
      }),
    };
  } catch (err) {
    console.error(`Error selecting lucky draw winners for mission ${missionId}:`, err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'internal_error', message: err.message }),
    };
  }
};

/**
 * Queries all ENTRY# records for a mission, handling DynamoDB pagination.
 * @param {string} missionId - Mission identifier
 * @returns {Promise<Array>} All eligible entries
 */
async function queryAllEntries(missionId) {
  const entries = [];
  let lastEvaluatedKey = undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `MISSION#${missionId}`,
        ':skPrefix': 'ENTRY#',
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    if (result.Items) {
      entries.push(...result.Items);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return entries;
}

/**
 * Selects N random winners from entries using a partial Fisher-Yates shuffle
 * with cryptographically secure randomness (crypto.randomInt).
 *
 * This shuffles only the first N positions of the array, which is sufficient
 * to select N random elements without bias.
 *
 * @param {Array} entries - All eligible entries
 * @param {number} n - Number of winners to select
 * @returns {Array} Selected winners
 */
function selectRandomWinners(entries, n) {
  if (n === 0 || entries.length === 0) {
    return [];
  }

  // If selecting all entries, no shuffle needed
  if (n >= entries.length) {
    return [...entries];
  }

  // Partial Fisher-Yates shuffle: only shuffle first n positions
  const arr = [...entries];
  for (let i = 0; i < n; i++) {
    // Pick a random index from i to arr.length - 1 (inclusive)
    const j = randomInt(i, arr.length);
    // Swap arr[i] and arr[j]
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }

  return arr.slice(0, n);
}

// Export for testing
export { queryAllEntries, selectRandomWinners };
