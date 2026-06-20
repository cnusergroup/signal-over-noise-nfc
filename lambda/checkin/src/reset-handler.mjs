/**
 * Reset handler — clears participant activity / statistics data.
 *
 * POST /admin/reset-stats (admin only).
 *
 * DELETES (participant-generated data):
 *   - All check-in records EXCEPT station 1 (SK 'CHECKIN#1' is preserved as the
 *     default baseline — every participant stays "checked in at station 1")
 *   - After-party check-ins (SK 'AFTER_PARTY')
 *   - Stamp rally completions (SK 'STAMPRALLY')
 *   - Leaderboard entries (PK 'LEADERBOARD')
 *   - Combo awards on tags (SK begins with 'COMBO#')
 *   - All mission data incl. config (PK begins with 'MISSION#')
 *   - Lottery nicknames (SK 'NICKNAME') and reservations (PK begins 'NICKNAME#')
 *   - Lottery winners + draw counter (PK 'LOTTERY')
 *
 * PRESERVES (configuration / baseline):
 *   - Tag registry (SK 'REGISTRY')
 *   - Scanner config (PK begins 'SCANNER#')
 *   - Combo definitions (PK begins 'COMBO#', SK 'CONFIG')
 *   - Station-1 default check-ins (SK 'CHECKIN#1')
 *   - Lottery settings (PK 'CONFIG', SK 'LOTTERY_SETTINGS')
 *   - Lunch/Party entitlement verifications and reward redemptions
 */

import { ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName } from './utils/dynamo.mjs';
import { ok, error } from './utils/response.mjs';

/** Returns true if the caller belongs to the `admin` Cognito group. */
function isAdmin(claims) {
  if (!claims) return false;
  const groups = claims['cognito:groups'];
  if (!groups) return false;
  let list;
  if (Array.isArray(groups)) list = groups;
  else if (typeof groups === 'string') {
    const cleaned = groups.replace(/^\[|\]$/g, '').trim();
    list = cleaned ? cleaned.split(/\s*,\s*/) : [];
  } else list = [];
  return list.includes('admin');
}

/** Decides whether a given item is participant statistics data to be cleared. */
function shouldDelete(pk, sk) {
  if (typeof pk !== 'string' || typeof sk !== 'string') return false;
  if (sk.startsWith('CHECKIN#') && sk !== 'CHECKIN#1') return true; // keep station 1
  if (sk === 'AFTER_PARTY') return true;
  if (sk === 'STAMPRALLY') return true;
  if (pk === 'LEADERBOARD') return true;
  if (sk.startsWith('COMBO#')) return true;          // tag combo awards (configs use SK='CONFIG')
  if (pk.startsWith('MISSION#')) return true;        // all mission data incl. CONFIG
  if (sk === 'NICKNAME') return true;
  if (pk.startsWith('NICKNAME#')) return true;
  if (pk === 'LOTTERY') return true;                 // WINNER#* + DRAW_COUNTER
  return false;
}

/**
 * Handles POST /admin/reset-stats.
 * @param {object} claims - JWT claims from the API Gateway authorizer
 * @returns {Promise<object>} API Gateway response
 */
export async function handleResetStats(claims) {
  if (!isAdmin(claims)) {
    return error(403, 'forbidden', 'Admin group membership required');
  }

  const client = getDocClient();
  const tableName = getTableName();

  // 1. Scan the whole table (PK/SK only) and collect keys to delete.
  const keys = [];
  let lastKey;
  try {
    do {
      const res = await client.send(new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: lastKey,
      }));
      for (const it of res.Items || []) {
        if (shouldDelete(it.PK, it.SK)) keys.push({ PK: it.PK, SK: it.SK });
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
  } catch (err) {
    console.error('Reset scan error:', err);
    return error(500, 'internal_error', 'Failed to scan table for reset');
  }

  // 2. Delete in batches of 25 with bounded concurrency.
  const batches = [];
  for (let i = 0; i < keys.length; i += 25) {
    batches.push(keys.slice(i, i + 25));
  }

  const CONCURRENCY = 8;
  let deleted = 0;
  try {
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const slice = batches.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map((batch) =>
        client.send(new BatchWriteCommand({
          RequestItems: { [tableName]: batch.map((Key) => ({ DeleteRequest: { Key } })) },
        }))
      ));
      deleted += slice.reduce((n, b) => n + b.length, 0);
    }
  } catch (err) {
    console.error('Reset delete error:', err);
    return error(500, 'internal_error', `Reset partially failed after deleting ~${deleted} items`);
  }

  return ok({ reset: true, deletedCount: deleted });
}
