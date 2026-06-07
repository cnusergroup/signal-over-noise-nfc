# Scripts — NFC Check-in Backend

Utility scripts for seeding DynamoDB with initial configuration data required by the NFC Check-in Backend.

## Required Environment Variables

| Variable | Description | Required By |
|----------|-------------|-------------|
| `TABLE_NAME` | DynamoDB table name (e.g., `SignalHuntTable`) | All scripts, Lambda functions |
| `API_KEY` | API key for admin endpoint authentication | Check-in Lambda |
| `SCHEDULER_ROLE_ARN` | IAM role ARN for EventBridge Scheduler | Check-in Lambda (mission creation) |
| `LUCKY_DRAW_LAMBDA_ARN` | ARN of the Lucky Draw Lambda function | Check-in Lambda (mission creation) |
| `LAST_CALL_LAMBDA_ARN` | ARN of the Last Call Lambda function | Check-in Lambda (mission creation) |

## Seed Scripts

### seed-tags.mjs

Seeds NFC tag registry records into DynamoDB. Each tag is stored with key pattern `PK=TAG#{tagId}, SK=REGISTRY`.

**Usage:**

```bash
# Seed default 10 sample tags (tag-001 through tag-010)
TABLE_NAME=SignalHuntTable node scripts/seed-tags.mjs

# Seed from a custom JSON file
TABLE_NAME=SignalHuntTable node scripts/seed-tags.mjs ./my-tags.json
```

**Custom JSON format:**

```json
[
  "badge-alpha-001",
  "badge-alpha-002",
  "badge-beta-001",
  "vip-tag-001"
]
```

The file must contain a JSON array of strings, where each string is a tag ID.

---

### seed-scanners.mjs

Seeds scanner-to-station mapping records into DynamoDB. Each mapping is stored with key pattern `PK=SCANNER#{scannerId}, SK=CONFIG` and includes a `stationId` field.

**Usage:**

```bash
# Seed default 10 mappings (scanner-01 → station 1, ..., scanner-10 → station 10)
TABLE_NAME=SignalHuntTable node scripts/seed-scanners.mjs

# Seed from a custom JSON file
TABLE_NAME=SignalHuntTable node scripts/seed-scanners.mjs ./my-scanners.json
```

**Custom JSON format:**

```json
[
  { "scannerId": "lobby-scanner-A", "stationId": 1 },
  { "scannerId": "lobby-scanner-B", "stationId": 1 },
  { "scannerId": "hall-scanner-01", "stationId": 2 },
  { "scannerId": "hall-scanner-02", "stationId": 3 }
]
```

Each object must have:
- `scannerId` — a string identifier for the scanner device
- `stationId` — an integer from 1 to 10 (inclusive)

Multiple scanners can map to the same station.

---

## Running Against a Deployed Table

1. Ensure your AWS credentials are configured (via `~/.aws/credentials`, environment variables, or IAM role).
2. Set the `TABLE_NAME` environment variable to your deployed table name.
3. Run the desired script:

```bash
export TABLE_NAME=SignalHuntCheckinStack-CheckinTableXXXXXX-YYYYYY
node scripts/seed-tags.mjs
node scripts/seed-scanners.mjs
```

## Running Against DynamoDB Local

For local development and testing:

```bash
export TABLE_NAME=SignalHuntTable
export AWS_ENDPOINT_URL=http://localhost:8000
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local

node scripts/seed-tags.mjs
node scripts/seed-scanners.mjs
```

## Notes

- Both scripts use `BatchWriteItem` for efficiency (up to 25 items per batch).
- Unprocessed items are automatically retried up to 3 times with exponential backoff.
- Scripts are idempotent — running them again will overwrite existing records with the same keys.
- The default data sets are suitable for development and testing. Use custom JSON files for production deployments with real scanner/tag identifiers.
