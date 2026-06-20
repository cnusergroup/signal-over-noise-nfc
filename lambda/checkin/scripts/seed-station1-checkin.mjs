#!/usr/bin/env node
/**
 * One-off: give EVERY registered NFC tag a check-in at station 1 by default.
 *
 * - Scans the registry (SK = 'REGISTRY') to collect all tagIds.
 * - For each tag, writes a CHECKIN#1 record identical in shape to a real
 *   check-in (GSI1 keys, afterParty flag, ttl), using a conditional put so an
 *   existing real station-1 check-in is never overwritten.
 *
 * Usage (from lambda/checkin):
 *   TABLE_NAME=<table> node scripts/seed-station1-checkin.mjs
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME;
const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const STATION_ID = 1;
// After Party time gate: 2026-06-28T09:00:00Z. A station-1 seed before the gate
// is NOT an after-party check-in.
const AFTER_PARTY_GATE_MS = Date.parse('2026-06-28T09:00:00Z');

if (!TABLE) {
  console.error('Error: TABLE_NAME environment variable is required.');
  process.exit(1);
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

async function collectTagIds() {
  const tagIds = [];
  let lastKey;
  do {
    const res = await client.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'REGISTRY' },
      ProjectionExpression: 'tagId, PK',
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items || []) {
      const tagId = item.tagId || (typeof item.PK === 'string' ? item.PK.replace(/^TAG#/, '') : null);
      if (tagId) tagIds.push(tagId);
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return tagIds;
}

async function seed() {
  const tagIds = await collectTagIds();
  console.log(`Found ${tagIds.length} registered tag(s). Writing station ${STATION_ID} check-ins...`);

  const nowMs = Date.now();
  const checkinTime = new Date(nowMs).toISOString();
  const ttl = Math.floor(nowMs / 1000) + 30 * 24 * 60 * 60;
  const afterParty = nowMs >= AFTER_PARTY_GATE_MS;

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const tagId of tagIds) {
    try {
      await client.send(new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `TAG#${tagId}`,
          SK: `CHECKIN#${STATION_ID}`,
          GSI1PK: `STATION#${STATION_ID}`,
          GSI1SK: `CHECKIN#${checkinTime}`,
          tagId,
          stationId: STATION_ID,
          checkinTime,
          afterParty,
          ttl,
        },
        // Do not overwrite an existing real station-1 check-in.
        ConditionExpression: 'attribute_not_exists(SK)',
      }));
      created++;
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        skipped++;
      } else {
        errors++;
        console.error(`  Error for ${tagId}: ${err.message}`);
      }
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped (already checked in): ${skipped}, Errors: ${errors}`);
}

seed().catch((e) => { console.error('Fatal:', e); process.exit(1); });
