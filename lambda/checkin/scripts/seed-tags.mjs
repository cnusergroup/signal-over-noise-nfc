#!/usr/bin/env node

/**
 * Seed NFC tag registry records into DynamoDB.
 *
 * Usage:
 *   TABLE_NAME=SignalHuntTable node scripts/seed-tags.mjs
 *   TABLE_NAME=SignalHuntTable node scripts/seed-tags.mjs ./custom-tags.json
 *
 * The JSON file should contain an array of tag ID strings:
 *   ["tag-001", "tag-002", "my-custom-tag"]
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { readFileSync } from 'node:fs';

const TABLE_NAME = process.env.TABLE_NAME;

if (!TABLE_NAME) {
  console.error('Error: TABLE_NAME environment variable is required.');
  process.exit(1);
}

// Default sample tags for testing
const DEFAULT_TAGS = [
  'tag-001', 'tag-002', 'tag-003', 'tag-004', 'tag-005',
  'tag-006', 'tag-007', 'tag-008', 'tag-009', 'tag-010',
];

/**
 * Load tag IDs from a JSON file or use defaults.
 * @returns {string[]}
 */
function loadTagIds() {
  const jsonPath = process.argv[2];
  if (jsonPath) {
    try {
      const content = readFileSync(jsonPath, 'utf-8');
      const tags = JSON.parse(content);
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
        console.error('Error: JSON file must contain an array of strings.');
        process.exit(1);
      }
      console.log(`Loaded ${tags.length} tag(s) from ${jsonPath}`);
      return tags;
    } catch (err) {
      console.error(`Error reading JSON file: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`Using default ${DEFAULT_TAGS.length} sample tags.`);
  return DEFAULT_TAGS;
}

/**
 * Seed tag registry records using BatchWriteItem.
 * DynamoDB BatchWriteItem supports up to 25 items per batch.
 */
async function seedTags() {
  const client = new DynamoDBClient({});
  const docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });

  const tagIds = loadTagIds();
  const BATCH_SIZE = 25;
  let totalWritten = 0;

  for (let i = 0; i < tagIds.length; i += BATCH_SIZE) {
    const batch = tagIds.slice(i, i + BATCH_SIZE);
    const putRequests = batch.map((tagId) => ({
      PutRequest: {
        Item: {
          PK: `TAG#${tagId}`,
          SK: 'REGISTRY',
          tagId,
          registeredAt: new Date().toISOString(),
        },
      },
    }));

    const command = new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: putRequests,
      },
    });

    const response = await docClient.send(command);

    // Handle unprocessed items with retry
    let unprocessed = response.UnprocessedItems?.[TABLE_NAME];
    let retries = 0;
    while (unprocessed && unprocessed.length > 0 && retries < 3) {
      retries++;
      console.log(`  Retrying ${unprocessed.length} unprocessed item(s) (attempt ${retries})...`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
      const retryCommand = new BatchWriteCommand({
        RequestItems: { [TABLE_NAME]: unprocessed },
      });
      const retryResponse = await docClient.send(retryCommand);
      unprocessed = retryResponse.UnprocessedItems?.[TABLE_NAME];
    }

    if (unprocessed && unprocessed.length > 0) {
      console.error(`  Failed to write ${unprocessed.length} item(s) after retries.`);
    }

    totalWritten += batch.length;
    console.log(`  Written batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} tag(s)`);
  }

  console.log(`\nDone. Seeded ${totalWritten} tag registry record(s) into table "${TABLE_NAME}".`);
}

seedTags().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
