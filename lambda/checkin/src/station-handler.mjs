/**
 * Station handler — queries station traffic data.
 * Supports single station detail and all-stations summary.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, buildGSIKeyCondition } from './utils/dynamo.mjs';
import { filterExpired } from './utils/time.mjs';
import { ok, invalidField, internalError } from './utils/response.mjs';

/**
 * Validates that a stationId is an integer between 1 and 10.
 * @param {*} stationId - Value to validate
 * @returns {{ valid: boolean, parsed?: number }}
 */
function validateStationId(stationId) {
  const parsed = Number(stationId);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    return { valid: false };
  }
  return { valid: true, parsed };
}

/**
 * Queries all check-in records for a given station from GSI1.
 * @param {number} stationId - Station identifier (1-10)
 * @returns {Promise<Array>} Array of check-in records (filtered for expiry)
 */
async function queryStationRecords(stationId) {
  const client = getDocClient();
  const tableName = getTableName();

  const gsiParams = buildGSIKeyCondition('GSI1', `STATION#${stationId}`, {
    beginsWith: 'CHECKIN#',
  });

  const result = await client.send(new QueryCommand({
    TableName: tableName,
    ...gsiParams,
    ScanIndexForward: false, // Descending by GSI1SK (timestamp)
  }));

  return filterExpired(result.Items || []);
}

/**
 * Handles GET /stations/{stationId} requests.
 * Returns unique visitor count and up to 1000 recent check-in timestamps (descending).
 * @param {*} stationId - Station identifier (1-10)
 * @returns {Promise<object>} Response object
 */
export async function handleStationTraffic(stationId) {
  // Validate stationId
  const validation = validateStationId(stationId);
  if (!validation.valid) {
    return invalidField('stationId', 'Station identifier must be an integer between 1 and 10');
  }

  try {
    const records = await queryStationRecords(validation.parsed);

    // Count unique visitors (distinct tagId values)
    const uniqueTags = new Set(records.map(r => r.tagId));

    // Extract timestamps, already sorted descending from query, limit to 1000
    const recentCheckins = records
      .map(r => r.checkinTime)
      .filter(Boolean)
      .slice(0, 1000);

    return ok({
      stationId: validation.parsed,
      uniqueVisitors: uniqueTags.size,
      recentCheckins,
    });
  } catch (err) {
    console.error('DynamoDB error querying station traffic:', err);
    return internalError('Failed to query station traffic');
  }
}

/**
 * Handles GET /stations requests (summary of all stations).
 * Returns unique visitor count for each station 1-10.
 * @returns {Promise<object>} Response object
 */
export async function handleStationSummary() {
  try {
    const stations = [];

    // Query each station 1-10
    for (let id = 1; id <= 10; id++) {
      const records = await queryStationRecords(id);
      const uniqueTags = new Set(records.map(r => r.tagId));
      stations.push({
        stationId: id,
        uniqueVisitors: uniqueTags.size,
      });
    }

    return ok({ stations });
  } catch (err) {
    console.error('DynamoDB error querying station summary:', err);
    return internalError('Failed to query station summary');
  }
}
