#!/usr/bin/env node
/**
 * One-off: delete ALL items belonging to a mission (CONFIG, COUNTER, ENTRY#*, etc).
 * Works regardless of mission status (bypasses the API's 409 guard for active missions).
 *
 * Usage (from lambda/checkin):
 *   TABLE_NAME=<table> node scripts/delete-mission.mjs MISSION#<id>
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME;
const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const PK = process.argv[2];

if (!TABLE) { console.error('Error: TABLE_NAME env var required.'); process.exit(1); }
if (!PK || !PK.startsWith('MISSION#')) { console.error('Usage: node scripts/delete-mission.mjs MISSION#<id>'); process.exit(1); }

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function run() {
  // Collect all SKs under this PK
  const keys = [];
  let lastKey;
  do {
    const res = await client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': PK },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: lastKey,
    }));
    for (const it of res.Items || []) keys.push({ PK: it.PK, SK: it.SK });
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  console.log(`Found ${keys.length} item(s) under ${PK}. Deleting...`);

  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);
    await client.send(new BatchWriteCommand({
      RequestItems: { [TABLE]: batch.map((Key) => ({ DeleteRequest: { Key } })) },
    }));
    console.log(`  Deleted ${Math.min(i + 25, keys.length)}/${keys.length}`);
  }

  console.log('Done.');
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
