#!/usr/bin/env node

/**
 * Seed scanner-to-station mapping records into DynamoDB.
 *
 * Usage:
 *   TABLE_NAME=SignalHuntTable node scripts/seed-scanners.mjs
 *   TABLE_NAME=SignalHuntTable node scripts/seed-scanners.mjs ./custom-scanners.json
 *
 * The JSON file should contain an array of objects with scannerId and stationId:
 *   [
 *     { "scannerId": "scanner-01", "stationId": 1 },
 *     { "scannerId": "scanner-02", "stationId": 2 }
 *   ]
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { readFileSync } from 'node:fs';

const TABLE_NAME = process.env.TABLE_NAME;

if (!TABLE_NAME) {
  console.error('Error: TABLE_NAME environment variable is required.');
  process.exit(1);
}

// Default scanner-to-station mappings (scanner-01 → station 1, etc.)
const DEFAULT_MAPPINGS = Array.from({ length: 10 }, (_, i) => ({
  scannerId: `scanner-${String(i + 1).padStart(2, '0')}`,
  stationId: i + 1,
}));

/**
 * Load scanner mappings from a JSON file or use defaults.
 * @returns {{ scannerId: string, stationId: number }[]}
 */
function loadMappings() {
  const jsonPath = process.argv[2];
  if (jsonPath) {
    try {
      const content = readFileSync(jsonPath, 'utf-8');
      const mappings = JSON.parse(content);
      if (!Array.isArray(mappings)) {
        console.error('Error: JSON file must contain an array of objects.');
        process.exit(1);
      }
      for (const m of mappings) {
        if (!m.scannerId || typeof m.scannerId !== 'string') {
          console.error('Error: Each mapping must have a string "scannerId" field.');
          process.exit(1);
        }
        if (!Number.isInteger(m.stationId) || m.stationId < 1 || m.stationId > 10) {
          console.error(`Error: stationId must be an integer 1–10. Got "${m.stationId}" for scanner "${m.scannerId}".`);
          process.exit(1);
        }
      }
      console.log(`Loaded ${mappings.length} mapping(s) from ${jsonPath}`);
      return mappings;
    } catch (err) {
      if (err.message.startsWith('Error:')) throw err;
      console.error(`Error reading JSON file: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`Using default ${DEFAULT_MAPPINGS.length} scanner-to-station mappings.`);
  return DEFAULT_MAPPINGS;
}

/**
 * Seed scanner mapping records using BatchWriteItem.
 * DynamoDB BatchWriteItem supports up to 25 items per batch.
 */
async function seedScanners() {
  const client = new DynamoDBClient({});
  const docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });

  const mappings = loadMappings();
  const BATCH_SIZE = 25;
  let totalWritten = 0;

  for (let i = 0; i < mappings.length; i += BATCH_SIZE) {
    const batch = mappings.slice(i, i + BATCH_SIZE);
    const putRequests = batch.map(({ scannerId, stationId }) => ({
      PutRequest: {
        Item: {
          PK: `SCANNER#${scannerId}`,
          SK: 'CONFIG',
          scannerId,
          stationId,
          configuredAt: new Date().toISOString(),
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
    console.log(`  Written batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} mapping(s)`);
  }

  console.log(`\nDone. Seeded ${totalWritten} scanner mapping(s) into table "${TABLE_NAME}".`);
}

seedScanners().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
