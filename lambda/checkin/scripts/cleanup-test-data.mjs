#!/usr/bin/env node
/**
 * Cleanup test data:
 * 1. tag-001 ~ tag-300: REGISTRY + all CHECKIN# + STAMPRALLY + NICKNAME + AFTER_PARTY + COMBO# etc.
 * 2. demo-tag-1 ~ demo-tag-20: same + NICKNAME reservations
 * 3. Test lottery participants with test:true flag (NICKNAME# records)
 *
 * Usage: TABLE_NAME=<table> node scripts/cleanup-test-data.mjs
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME;
const REGION = process.env.AWS_REGION || 'ap-northeast-1';
if (!TABLE) { console.error('Error: TABLE_NAME required.'); process.exit(1); }

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const BATCH = 25;
const CONCURRENCY = 8;
let totalDeleted = 0;

async function deleteKeys(keys) {
  if (keys.length === 0) return;
  const batches = [];
  for (let i = 0; i < keys.length; i += BATCH) batches.push(keys.slice(i, i + BATCH));

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(batch =>
      client.send(new BatchWriteCommand({
        RequestItems: { [TABLE]: batch.map(Key => ({ DeleteRequest: { Key } })) }
      }))
    ));
    totalDeleted += slice.reduce((n, b) => n + b.length, 0);
  }
}

async function queryAllForPK(pk) {
  const keys = [];
  let lastKey;
  do {
    const res = await client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: lastKey,
    }));
    for (const it of res.Items || []) keys.push({ PK: it.PK, SK: it.SK });
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return keys;
}

async function cleanupTagRange(prefix, start, end) {
  console.log(`\nCleaning ${prefix}${start} ~ ${prefix}${end}...`);
  for (let i = start; i <= end; i++) {
    const tagId = `${prefix}${i}`;
    // All records under TAG#{tagId}
    const tagKeys = await queryAllForPK(`TAG#${tagId}`);
    // Also check for NICKNAME reservation (if nickname was registered for this tag)
    // We'll handle that via the nickname scan below
    await deleteKeys(tagKeys);
    if (tagKeys.length > 0 && i % 50 === 0) {
      console.log(`  ... ${tagId} (${tagKeys.length} items)`);
    }
  }
}

async function cleanupDemoTags() {
  console.log('\nCleaning demo-tag-1 ~ demo-tag-20...');
  for (let i = 1; i <= 20; i++) {
    const tagId = `demo-tag-${i}`;
    const tagKeys = await queryAllForPK(`TAG#${tagId}`);
    await deleteKeys(tagKeys);
  }
  // Also clean NICKNAME# reservations that reference demo-tag-*
  console.log('  Scanning NICKNAME# reservations for demo-tag references...');
  let lastKey;
  const nickKeys = [];
  do {
    const res = await client.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'begins_with(PK, :np) AND begins_with(tagId, :dt)',
      ExpressionAttributeValues: { ':np': 'NICKNAME#', ':dt': 'demo-tag-' },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: lastKey,
    }));
    for (const it of res.Items || []) nickKeys.push({ PK: it.PK, SK: it.SK });
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  if (nickKeys.length > 0) {
    console.log(`  Found ${nickKeys.length} demo NICKNAME reservations to delete`);
    await deleteKeys(nickKeys);
  }
}

async function cleanupTestParticipants() {
  console.log('\nCleaning test lottery participants (test=true)...');
  let lastKey;
  const keys = [];
  do {
    const res = await client.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'begins_with(PK, :np) AND #t = :tv',
      ExpressionAttributeNames: { '#t': 'test' },
      ExpressionAttributeValues: { ':np': 'NICKNAME#', ':tv': true },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: lastKey,
    }));
    for (const it of res.Items || []) keys.push({ PK: it.PK, SK: it.SK });
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  console.log(`  Found ${keys.length} test participants to delete`);
  await deleteKeys(keys);
}

async function cleanupTestTagRegistries() {
  // Delete REGISTRY records for tag-001~tag-300
  console.log('\nDeleting tag-001 ~ tag-300 REGISTRY records...');
  const keys = [];
  for (let i = 1; i <= 300; i++) {
    keys.push({ PK: `TAG#tag-${String(i).padStart(3, '0')}`, SK: 'REGISTRY' });
  }
  await deleteKeys(keys);
}

async function main() {
  console.log('=== Test Data Cleanup ===');
  console.log(`Table: ${TABLE}\n`);

  // 1. tag-001 ~ tag-300 (all data + registry)
  await cleanupTagRange('tag-', 1, 300);
  await cleanupTestTagRegistries();

  // 2. demo-tag-1 ~ demo-tag-20
  await cleanupDemoTags();

  // 3. Test lottery participants (test=true)
  await cleanupTestParticipants();

  // 4. Also clean LOTTERY winner/counter records (from test draws)
  console.log('\nCleaning LOTTERY records (test draws)...');
  const lotteryKeys = await queryAllForPK('LOTTERY');
  await deleteKeys(lotteryKeys);

  console.log(`\n=== Done! Total deleted: ${totalDeleted} items ===`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
