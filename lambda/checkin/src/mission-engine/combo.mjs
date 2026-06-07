/**
 * Combo evaluator — checks if a check-in completes any defined combo set.
 * Awards each combo at most once per tag via conditional PutItem.
 */

import { QueryCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { buildGSIKeyCondition, buildKeyCondition } from '../utils/dynamo.mjs';
import { filterExpired } from '../utils/time.mjs';

/**
 * Queries all combo configurations from DynamoDB via GSI1.
 * @param {object} deps - { client, tableName }
 * @returns {Promise<Array>} List of combo config records
 */
async function getAllCombos(deps) {
  const { client, tableName } = deps;
  const gsiCondition = buildGSIKeyCondition('GSI1', 'COMBO_LIST');

  const result = await client.send(new QueryCommand({
    TableName: tableName,
    ...gsiCondition,
  }));

  return result.Items || [];
}

/**
 * Queries all check-in records for a tag and returns the set of visited station IDs.
 * Filters out expired records.
 * @param {string} tagId - NFC tag identifier
 * @param {object} deps - { client, tableName }
 * @returns {Promise<Set<number>>} Set of visited station IDs
 */
async function queryVisitedStations(tagId, deps) {
  const { client, tableName } = deps;
  const keyCondition = buildKeyCondition(`TAG#${tagId}`, { beginsWith: 'CHECKIN#' });

  const result = await client.send(new QueryCommand({
    TableName: tableName,
    ...keyCondition,
  }));

  const records = filterExpired(result.Items || []);
  const stations = new Set();

  for (const record of records) {
    // SK format: CHECKIN#{stationId}
    const sk = record.SK;
    if (sk && sk.startsWith('CHECKIN#')) {
      const stationId = parseInt(sk.replace('CHECKIN#', ''), 10);
      if (!isNaN(stationId)) {
        stations.add(stationId);
      }
    }
  }

  return stations;
}

/**
 * Checks if a combo has already been awarded to a tag.
 * @param {string} tagId - NFC tag identifier
 * @param {string} comboName - Combo name
 * @param {object} deps - { client, tableName }
 * @returns {Promise<boolean>} True if already awarded
 */
async function isComboAwarded(tagId, comboName, deps) {
  const { client, tableName } = deps;

  const result = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `TAG#${tagId}`, SK: `COMBO#${comboName}` },
  }));

  return !!result.Item;
}

/**
 * Awards a combo to a tag with conditional PutItem (at-most-once).
 * @param {string} tagId - NFC tag identifier
 * @param {object} combo - Combo config { name, stations, reward }
 * @param {object} deps - { client, tableName }
 * @returns {Promise<boolean>} True if newly awarded, false if already existed
 */
async function awardCombo(tagId, combo, deps) {
  const { client, tableName } = deps;

  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `TAG#${tagId}`,
        SK: `COMBO#${combo.name}`,
        comboName: combo.name,
        reward: combo.reward,
        stations: combo.stations,
        awardedAt: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Already awarded by a concurrent request — not an error
      return false;
    }
    throw err;
  }
}

/**
 * Checks if visitedStations is a superset of the combo's required stations.
 * @param {Set<number>} visitedStations - Set of visited station IDs
 * @param {Array<number>} requiredStations - Array of required station IDs
 * @returns {boolean} True if all required stations are visited
 */
function isSuperset(visitedStations, requiredStations) {
  for (const station of requiredStations) {
    if (!visitedStations.has(station)) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluates combo bonuses for a check-in.
 * 1. Get all combo configs (GSI1 COMBO_LIST)
 * 2. Get tag's visited stations (from parameter or query)
 * 3. Filter expired check-in records
 * 4. For each combo: check if visited stations is a superset of combo's required stations
 * 5. For each matching combo: check if already awarded
 * 6. If not awarded: PutItem with ConditionExpression (at-most-once)
 * 7. Handle ConditionalCheckFailedException
 * 8. Return array of newly completed combos
 *
 * @param {string} tagId - NFC tag identifier
 * @param {Set<number>|undefined} visitedStations - Set of station IDs visited by this tag (queried if undefined)
 * @param {object} deps - Injected dependencies { client, tableName }
 * @returns {Promise<Array<{ comboName: string, reward: string, stations: number[] }>>} List of newly completed combos
 */
export async function evaluateCombos(tagId, visitedStations, deps) {
  // 1. Get all combo configs
  const combos = await getAllCombos(deps);

  if (combos.length === 0) {
    return [];
  }

  // 2. Get tag's visited stations (from parameter or query)
  let stations = visitedStations;
  if (!stations) {
    stations = await queryVisitedStations(tagId, deps);
  }

  // Ensure stations is a Set
  if (!(stations instanceof Set)) {
    stations = new Set(stations);
  }

  // 3. For each combo: check if visited stations is a superset of required stations
  const newlyCompleted = [];

  for (const combo of combos) {
    const requiredStations = combo.stations;

    if (!requiredStations || !Array.isArray(requiredStations) || requiredStations.length === 0) {
      continue;
    }

    if (!isSuperset(stations, requiredStations)) {
      continue;
    }

    // 4. Check if already awarded
    const alreadyAwarded = await isComboAwarded(tagId, combo.name, deps);
    if (alreadyAwarded) {
      continue;
    }

    // 5. Award the combo (at-most-once via conditional PutItem)
    const awarded = await awardCombo(tagId, combo, deps);
    if (awarded) {
      newlyCompleted.push({
        comboName: combo.name,
        reward: combo.reward,
        stations: combo.stations,
      });
    }
  }

  return newlyCompleted;
}
