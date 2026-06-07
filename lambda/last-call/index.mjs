/**
 * Last Call Finalization Lambda
 *
 * Triggered by EventBridge Scheduler at mission end time.
 * Queries the sliding window of recent check-ins for a Last Call mission,
 * selects the last N unique visitors (by most recent check-in timestamp) as winners,
 * writes winner records, and updates mission status to completed.
 *
 * Handles the case where fewer than N entries exist by selecting all as winners.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE_NAME = process.env.TABLE_NAME;

export const handler = async (event) => {
  console.log('Last Call Lambda invoked', JSON.stringify(event));

  const { missionId } = event;

  if (!missionId) {
    console.error('Missing missionId in event payload');
    return { statusCode: 400, body: 'Missing missionId' };
  }

  try {
    // 1. Get mission config to determine winnerCount (N)
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

    // Calculate TTL from mission end time (endTime + 30 days)
    const endTimeMs = missionConfig.endTime
      ? (typeof missionConfig.endTime === 'string' ? new Date(missionConfig.endTime).getTime() : missionConfig.endTime)
      : Date.now();
    const ttl = Math.floor(endTimeMs / 1000) + 30 * 24 * 60 * 60;

    console.log(`Mission ${missionId}: selecting up to ${winnerCount} winners`);

    // 2. Query all last call entries for this mission
    const entries = await queryAllLastCallEntries(missionId);

    console.log(`Mission ${missionId}: found ${entries.length} last call entries`);

    // 3. Sort entries by checkinTime descending (most recent first)
    entries.sort((a, b) => {
      const timeA = new Date(a.checkinTime).getTime();
      const timeB = new Date(b.checkinTime).getTime();
      return timeB - timeA;
    });

    // 4. Select first N entries as winners (these are the "last" N visitors)
    //    Handle case where entries < N by selecting all
    const winnersToSelect = Math.min(winnerCount, entries.length);
    const winners = entries.slice(0, winnersToSelect);

    console.log(`Mission ${missionId}: selecting ${winnersToSelect} winners`);

    // 5. Write winner records
    for (const winner of winners) {
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `MISSION#${missionId}`,
          SK: `WINNER#${winner.tagId}`,
          tagId: winner.tagId,
          checkinTime: winner.checkinTime,
          awardedAt: new Date().toISOString(),
          ttl,
        },
      }));
    }

    // 6. Update mission status to 'completed'
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

    console.log(`Mission ${missionId}: finalization complete with ${winnersToSelect} winners`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        missionId,
        winnersSelected: winnersToSelect,
        totalEntries: entries.length,
      }),
    };
  } catch (err) {
    console.error(`Error finalizing last call mission ${missionId}:`, err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'internal_error', message: err.message }),
    };
  }
};

/**
 * Queries all LASTCALL# entries for a mission, handling pagination.
 * @param {string} missionId - Mission identifier
 * @returns {Promise<Array>} All last call entries
 */
async function queryAllLastCallEntries(missionId) {
  const entries = [];
  let lastEvaluatedKey = undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `MISSION#${missionId}`,
        ':skPrefix': 'LASTCALL#',
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
