/**
 * Leaderboard handler — returns speed challenge leaderboard.
 * Top 20 stamp rally completions sorted by elapsed time ascending.
 *
 * Also exports updateLeaderboard() for use by the stamp rally evaluator
 * when a completion is detected.
 */

import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, buildKeyCondition } from './utils/dynamo.mjs';
import { maskTagId } from './utils/crypto.mjs';
import { ok, internalError } from './utils/response.mjs';

/**
 * Handles GET /leaderboard requests.
 * Queries PK=LEADERBOARD, SK begins_with ENTRY#, limit 20, ascending sort.
 * Returns masked tagIds and elapsed seconds.
 *
 * @param {object} [deps] - Optional injected dependencies (for testing)
 * @param {object} [deps.client] - DynamoDB DocumentClient
 * @param {string} [deps.tableName] - Table name
 * @returns {Promise<object>} Response object
 */
export async function handleLeaderboard(deps) {
  const client = deps?.client || getDocClient();
  const tableName = deps?.tableName || getTableName();

  try {
    const keyCondition = buildKeyCondition('LEADERBOARD', { beginsWith: 'ENTRY#' });

    const result = await client.send(new QueryCommand({
      TableName: tableName,
      ...keyCondition,
      ScanIndexForward: true, // ascending by SK (elapsed time)
      Limit: 20,
    }));

    const items = result.Items || [];

    const entries = items.map(item => ({
      maskedTagId: maskTagId(item.tagId),
      elapsedSeconds: item.elapsedSeconds,
      completedAt: item.completedAt,
    }));

    // Get total count (separate query without limit for totalEntries)
    let totalEntries = entries.length;
    if (items.length === 20) {
      // There might be more entries — do a count query
      try {
        const countResult = await client.send(new QueryCommand({
          TableName: tableName,
          ...keyCondition,
          Select: 'COUNT',
        }));
        totalEntries = countResult.Count || 0;
      } catch {
        // Fall back to the items we have
        totalEntries = entries.length;
      }
    }

    return ok({
      entries,
      totalEntries,
    });
  } catch (err) {
    console.error('Error querying leaderboard:', err);
    return internalError('Failed to retrieve leaderboard');
  }
}

/**
 * Updates the leaderboard when a stamp rally is completed.
 * Calculates elapsed time and writes a leaderboard entry.
 * Uses conditional PutItem (attribute_not_exists) to prevent duplicate entries.
 *
 * @param {string} tagId - NFC tag identifier
 * @param {string[]} checkinTimestamps - Array of ISO 8601 check-in timestamps
 * @param {object} deps - Injected dependencies
 * @param {object} deps.client - DynamoDB DocumentClient
 * @param {string} deps.tableName - Table name
 * @returns {Promise<{ elapsedSeconds: number, completedAt: string } | null>} Leaderboard entry or null if already exists
 */
export async function updateLeaderboard(tagId, checkinTimestamps, deps) {
  const client = deps.client;
  const tableName = deps.tableName;

  if (!checkinTimestamps || checkinTimestamps.length === 0) {
    return null;
  }

  // Convert timestamps to milliseconds
  const timestampsMs = checkinTimestamps.map(ts => new Date(ts).getTime());

  // Calculate elapsed = max - min in whole seconds (truncated)
  const minTs = Math.min(...timestampsMs);
  const maxTs = Math.max(...timestampsMs);
  const elapsedSeconds = Math.floor((maxTs - minTs) / 1000);

  // completedAt is the latest check-in timestamp
  const completedAt = new Date(maxTs).toISOString();

  // Pad elapsed seconds to 6 digits for correct lexicographic sorting
  const paddedElapsed = String(elapsedSeconds).padStart(6, '0');
  const sk = `ENTRY#${paddedElapsed}#${tagId}`;

  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: 'LEADERBOARD',
        SK: sk,
        tagId,
        elapsedSeconds,
        completedAt,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    return { elapsedSeconds, completedAt };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Entry already exists — this is expected for idempotency
      return null;
    }
    console.error('Error writing leaderboard entry:', err);
    throw err;
  }
}
