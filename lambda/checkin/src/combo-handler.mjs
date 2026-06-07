/**
 * Combo handler — combo bonus CRUD operations.
 * POST /combos: create a new combo configuration (requires API key auth, validated by router).
 * GET /combos: list all combo configurations.
 */

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, buildGSIKeyCondition } from './utils/dynamo.mjs';
import { created, ok, internalError } from './utils/response.mjs';

/**
 * Handles POST/GET /combos requests.
 * Router has already validated the request body (for POST) and API key auth.
 *
 * @param {object} params - Route parameters
 * @param {string} params.method - HTTP method (POST or GET)
 * @param {object} [params.body] - Parsed request body (for POST)
 * @param {string} [params.action] - Action identifier (e.g., 'list' for GET)
 * @param {object} [deps] - Optional injected dependencies (for testing)
 * @param {object} [deps.client] - DynamoDB DocumentClient
 * @param {string} [deps.tableName] - Table name
 * @returns {Promise<object>} Response object
 */
export async function handleComboAdmin(params, deps) {
  const client = deps?.client || getDocClient();
  const tableName = deps?.tableName || getTableName();

  try {
    if (params.method === 'POST') {
      return await createCombo(params.body, client, tableName);
    }

    if (params.method === 'GET' || params.action === 'list') {
      return await listCombos(client, tableName);
    }

    return internalError('Unsupported combo operation');
  } catch (err) {
    console.error('Combo handler error:', err);
    return internalError('Failed to process combo request');
  }
}

/**
 * Creates a new combo configuration.
 * Writes PK=COMBO#{name}, SK=CONFIG with GSI1PK=COMBO_LIST, GSI1SK={name}.
 *
 * @param {object} body - Validated request body
 * @param {object} client - DynamoDB DocumentClient
 * @param {string} tableName - Table name
 * @returns {Promise<object>} 201 response with created combo
 */
async function createCombo(body, client, tableName) {
  const { name, stations, reward } = body;

  const item = {
    PK: `COMBO#${name}`,
    SK: 'CONFIG',
    GSI1PK: 'COMBO_LIST',
    GSI1SK: name,
    name,
    stations,
    reward,
    createdAt: new Date().toISOString(),
  };

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  return created({ name, stations, reward });
}

/**
 * Lists all combo configurations by querying GSI1 with COMBO_LIST partition.
 *
 * @param {object} client - DynamoDB DocumentClient
 * @param {string} tableName - Table name
 * @returns {Promise<object>} 200 response with array of combos
 */
async function listCombos(client, tableName) {
  const gsiCondition = buildGSIKeyCondition('GSI1', 'COMBO_LIST');

  const result = await client.send(new QueryCommand({
    TableName: tableName,
    ...gsiCondition,
  }));

  const combos = (result.Items || []).map(item => ({
    name: item.name,
    stations: item.stations,
    reward: item.reward,
  }));

  return ok(combos);
}
