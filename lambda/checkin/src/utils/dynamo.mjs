/**
 * DynamoDB client singleton and helper utilities.
 * Provides a shared DocumentClient instance and key expression builders.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let docClient = null;

/**
 * Returns a shared DynamoDB DocumentClient instance.
 * @returns {DynamoDBDocumentClient}
 */
export function getDocClient() {
  if (!docClient) {
    const client = new DynamoDBClient({});
    docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return docClient;
}

/**
 * Returns the table name from environment variables.
 * @returns {string}
 */
export function getTableName() {
  return process.env.TABLE_NAME;
}

/**
 * Resets the client singleton (useful for testing).
 * @param {DynamoDBDocumentClient|null} client - Optional mock client
 */
export function setDocClient(client) {
  docClient = client;
}

/**
 * Builds a composite key object for DynamoDB operations.
 * @param {string} pk - Partition key value
 * @param {string} sk - Sort key value
 * @returns {{ PK: string, SK: string }}
 */
export function buildKey(pk, sk) {
  return { PK: pk, SK: sk };
}

/**
 * Builds a key condition expression for Query operations on the base table.
 * @param {string} pk - Partition key value
 * @param {object} [skCondition] - Optional sort key condition
 * @param {string} [skCondition.beginsWith] - SK begins_with prefix
 * @param {string} [skCondition.equals] - SK exact match
 * @returns {{ KeyConditionExpression: string, ExpressionAttributeValues: object }}
 */
export function buildKeyCondition(pk, skCondition) {
  const values = { ':pk': pk };
  let expression = 'PK = :pk';

  if (skCondition) {
    if (skCondition.beginsWith) {
      expression += ' AND begins_with(SK, :skPrefix)';
      values[':skPrefix'] = skCondition.beginsWith;
    } else if (skCondition.equals) {
      expression += ' AND SK = :sk';
      values[':sk'] = skCondition.equals;
    }
  }

  return {
    KeyConditionExpression: expression,
    ExpressionAttributeValues: values,
  };
}

/**
 * Builds a key condition expression for Query operations on a GSI.
 * @param {string} indexName - GSI name ('GSI1' or 'GSI2')
 * @param {string} pk - GSI partition key value
 * @param {object} [skCondition] - Optional GSI sort key condition
 * @param {string} [skCondition.beginsWith] - GSI SK begins_with prefix
 * @param {string} [skCondition.equals] - GSI SK exact match
 * @returns {{ IndexName: string, KeyConditionExpression: string, ExpressionAttributeValues: object }}
 */
export function buildGSIKeyCondition(indexName, pk, skCondition) {
  const pkAttr = `${indexName}PK`;
  const skAttr = `${indexName}SK`;
  const values = { ':gsiPk': pk };
  let expression = `${pkAttr} = :gsiPk`;

  if (skCondition) {
    if (skCondition.beginsWith) {
      expression += ` AND begins_with(${skAttr}, :gsiSkPrefix)`;
      values[':gsiSkPrefix'] = skCondition.beginsWith;
    } else if (skCondition.equals) {
      expression += ` AND ${skAttr} = :gsiSk`;
      values[':gsiSk'] = skCondition.equals;
    }
  }

  return {
    IndexName: indexName,
    KeyConditionExpression: expression,
    ExpressionAttributeValues: values,
  };
}
