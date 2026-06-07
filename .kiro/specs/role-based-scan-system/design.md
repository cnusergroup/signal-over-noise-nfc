# Design Document: Role-Based Scan System

## Overview

This design extends the existing Signal Hunt NFC check-in system to support role-differentiated scan behaviors. Authenticated exhibitors automatically check in participants at their assigned station. Authenticated staff access a verification panel for one-time lunch/party eligibility. Unauthenticated participants see the existing progress page unchanged.

The system leverages the existing Cognito User Pool, DynamoDB single-table, HTTP API with JWT authorizer, and signal_hunt.html popup interface.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     signal_hunt.html                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Participant   │  │ Exhibitor    │  │ Staff Verification   │  │
│  │ Progress View │  │ Scan View    │  │ Panel                │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│         │                  │                     │               │
│         ▼                  ▼                     ▼               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │           Role Detection (cognito-identity-js)           │    │
│  │  localStorage session → ID token → cognito:groups claim  │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway (HTTP API)                         │
│  POST /checkin (public)    POST /verify/lunch (JWT + staff)      │
│  GET /checkin/{tagId}      POST /verify/party (JWT + staff)      │
└─────────────────────────────────────────────────────────────────┘
         │                                        │
         ▼                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Lambda (CheckinHandler)                        │
│  router.mjs → verify-handler.mjs (new)                          │
│              → checkin-handler.mjs (existing)                    │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DynamoDB (Single Table)                        │
│  TAG#{tagId} / LUNCH        — lunch verification record          │
│  TAG#{tagId} / PARTY        — party verification record          │
│  SCANNER#station-{n} / CONFIG — exhibitor scanner mappings       │
└─────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. CDK Infrastructure Changes (`infra/lib/signal-hunt-stack.ts`)

#### 1.1 Cognito Groups

Add three Cognito User Pool groups to the existing `AdminUserPool`:

```typescript
// Cognito Groups
new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
  userPoolId: userPool.userPoolId,
  groupName: 'admin',
  description: 'Full administrative access',
});

new cognito.CfnUserPoolGroup(this, 'ExhibitorGroup', {
  userPoolId: userPool.userPoolId,
  groupName: 'exhibitor',
  description: 'Exhibitor booth operators',
});

new cognito.CfnUserPoolGroup(this, 'StaffGroup', {
  userPoolId: userPool.userPoolId,
  groupName: 'staff',
  description: 'Event staff for verification',
});
```

#### 1.2 Custom Attribute

Add `custom:stationId` to the User Pool schema. Since the existing User Pool is already deployed, this requires adding the attribute via a Custom Resource (Cognito does not support adding custom attributes after creation via CloudFormation natively without replacement). Use `addSchema` via AwsCustomResource:

```typescript
new cr.AwsCustomResource(this, 'AddStationIdAttribute', {
  onCreate: {
    service: 'CognitoIdentityServiceProvider',
    action: 'addCustomAttributes',
    parameters: {
      UserPoolId: userPool.userPoolId,
      CustomAttributes: [{
        Name: 'stationId',
        AttributeDataType: 'String',
        Mutable: true,
        StringAttributeConstraints: { MinLength: '1', MaxLength: '10' },
      }],
    },
    physicalResourceId: cr.PhysicalResourceId.of('custom-attr-stationId'),
  },
  policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [userPool.userPoolArn] }),
});
```

#### 1.3 New API Routes

Add two new JWT-protected routes for verification:

```typescript
// POST /verify/lunch - Staff verification (JWT required)
httpApi.addRoutes({
  path: '/verify/lunch',
  methods: [apigatewayv2.HttpMethod.POST],
  integration: checkinIntegration,
  authorizer: jwtAuthorizer,
});

// POST /verify/party - Staff verification (JWT required)
httpApi.addRoutes({
  path: '/verify/party',
  methods: [apigatewayv2.HttpMethod.POST],
  integration: checkinIntegration,
  authorizer: jwtAuthorizer,
});
```

### 2. Lambda Changes

#### 2.1 Router Update (`lambda/checkin/src/router.mjs`)

Add route matching for the new verification endpoints before the catch-all:

```javascript
// POST /verify/lunch
if (method === 'POST' && path === '/verify/lunch') {
  const body = parseBody(event);
  const claims = extractClaims(event);
  return await handleVerify({ type: 'lunch', body, claims });
}

// POST /verify/party
if (method === 'POST' && path === '/verify/party') {
  const body = parseBody(event);
  const claims = extractClaims(event);
  return await handleVerify({ type: 'party', body, claims });
}
```

The `extractClaims` helper extracts JWT claims from the API Gateway event:

```javascript
function extractClaims(event) {
  return event.requestContext?.authorizer?.jwt?.claims || null;
}
```

#### 2.2 Verify Handler (`lambda/checkin/src/verify-handler.mjs`)

New handler module for lunch/party verification:

```javascript
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, buildKey } from './utils/dynamo.mjs';
import * as response from './utils/response.mjs';

/**
 * Checks if the user belongs to the "staff" or "admin" group.
 * @param {object} claims - JWT claims from API Gateway authorizer
 * @returns {boolean}
 */
function isStaffOrAdmin(claims) {
  if (!claims) return false;
  const groups = claims['cognito:groups'];
  if (!groups) return false;
  // groups may be a string (single group) or JSON array string
  const groupList = Array.isArray(groups) ? groups : 
    (typeof groups === 'string' ? (groups.startsWith('[') ? JSON.parse(groups) : [groups]) : []);
  return groupList.includes('staff') || groupList.includes('admin');
}

/**
 * Handles POST /verify/lunch and POST /verify/party.
 * @param {{ type: 'lunch'|'party', body: object|null, claims: object|null }} params
 * @returns {Promise<object>} API Gateway response
 */
export async function handleVerify({ type, body, claims }) {
  // 1. Authorization: check group membership
  if (!isStaffOrAdmin(claims)) {
    return response.buildErrorResponse(403, 'forbidden', 'Staff or admin group membership required');
  }

  // 2. Validate request body
  if (!body || !body.tagId || (typeof body.tagId === 'string' && body.tagId.trim() === '')) {
    return response.missingField('tagId');
  }

  const tagId = body.tagId.trim();
  const sk = type.toUpperCase(); // 'LUNCH' or 'PARTY'
  const client = getDocClient();
  const tableName = getTableName();

  // 3. Check if already verified
  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: buildKey(`TAG#${tagId}`, sk),
  }));

  if (existing.Item) {
    return response.buildErrorResponse(409, 'already_verified',
      `Tag ${tagId} has already been verified for ${type}`);
  }

  // 4. Create verification record
  await client.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `TAG#${tagId}`,
      SK: sk,
      tagId,
      type,
      verifiedAt: new Date().toISOString(),
      verifiedBy: claims.email || claims.sub || 'unknown',
    },
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  }));

  return response.ok({
    success: true,
    tagId,
    type,
    verifiedAt: new Date().toISOString(),
  });
}
```

#### 2.3 Error Handling

The `PutCommand` with `ConditionExpression` handles race conditions. If two staff members verify the same tag simultaneously, one will get a `ConditionalCheckFailedException`. The handler catches this and returns 409:

```javascript
try {
  await client.send(new PutCommand({ /* ... */ }));
} catch (err) {
  if (err.name === 'ConditionalCheckFailedException') {
    return response.buildErrorResponse(409, 'already_verified',
      `Tag ${tagId} has already been verified for ${type}`);
  }
  throw err;
}
```

### 3. Frontend Changes (`signal_hunt.html`)

#### 3.1 Cognito Session Management

Add the Amazon Cognito Identity JS SDK (loaded from CDN) and session management logic:

```html
<script src="https://unpkg.com/amazon-cognito-identity-js@6/dist/amazon-cognito-identity.min.js"></script>
```

Configuration constants:

```javascript
const COGNITO_USER_POOL_ID = 'ap-northeast-1_dBdKduSNI';
const COGNITO_CLIENT_ID = '43gokealbmen6doviustcfh62c';
```

#### 3.2 Role Detection Flow

On page load, before rendering the popup:

```javascript
function detectRole() {
  const poolData = {
    UserPoolId: COGNITO_USER_POOL_ID,
    ClientId: COGNITO_CLIENT_ID,
  };
  const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);
  const cognitoUser = userPool.getCurrentUser();

  if (!cognitoUser) return { role: 'participant', session: null };

  return new Promise((resolve) => {
    cognitoUser.getSession((err, session) => {
      if (err || !session || !session.isValid()) {
        resolve({ role: 'participant', session: null });
        return;
      }

      const idToken = session.getIdToken();
      const payload = idToken.decodePayload();
      const groups = payload['cognito:groups'] || [];
      const stationId = payload['custom:stationId'] || null;

      if (groups.includes('staff') || groups.includes('admin')) {
        resolve({ role: 'staff', session, jwt: idToken.getJwtToken() });
      } else if (groups.includes('exhibitor')) {
        resolve({ role: 'exhibitor', session, stationId, jwt: idToken.getJwtToken() });
      } else {
        resolve({ role: 'participant', session: null });
      }
    });
  });
}
```

#### 3.3 Exhibitor Interface

When role is `exhibitor`, the info popup renders a simplified scan interface:

```javascript
function renderExhibitorPopup(stationId) {
  // Replace popup content with exhibitor scan UI
  // Shows: "Station {stationId} Scanner" header
  // Shows: scan result area (success/error messages)
  // On tagId detection from URL: auto-calls POST /checkin with scannerId="station-{stationId}"
  const scannerId = `station-${stationId}`;
  // ... render simplified UI
}
```

The scannerId derivation: `"station-" + custom:stationId` value from the JWT.

#### 3.4 Staff Verification Interface

When role is `staff`, the info popup renders the verification panel:

```javascript
function renderStaffPopup(jwt) {
  // Shows: "Staff Verification" header
  // Shows: tagId input or auto-detected from URL
  // Shows: "Verify Lunch" button → POST /verify/lunch { tagId } + Authorization: Bearer {jwt}
  // Shows: "Verify Party" button → POST /verify/party { tagId } + Authorization: Bearer {jwt}
  // Shows: result indicators (✓ verified, ⚠ already verified, ✗ error)
}
```

#### 3.5 Participant Interface (Default)

When no session or role is `participant`, the existing `showInfoPopup()` behavior is preserved unchanged.

#### 3.6 Session Persistence

The `amazon-cognito-identity-js` library automatically stores tokens in localStorage under keys prefixed with `CognitoIdentityServiceProvider.{clientId}`. Session restoration and token refresh are handled by the library's `getSession()` method which:
1. Reads tokens from localStorage
2. Checks expiration of the ID token
3. If expired, uses the refresh token to obtain new tokens
4. If refresh fails, returns an error (triggering fallback to participant view)

### 4. Seed Script (`scripts/seed-users.mjs`)

#### 4.1 Input Format

JSON configuration file (`seed-users.json`):

```json
{
  "userPoolId": "ap-northeast-1_dBdKduSNI",
  "users": [
    {
      "email": "exhibitor1@example.com",
      "group": "exhibitor",
      "attributes": { "custom:stationId": "1" }
    },
    {
      "email": "exhibitor2@example.com",
      "group": "exhibitor",
      "attributes": { "custom:stationId": "2" }
    },
    {
      "email": "staff1@example.com",
      "group": "staff"
    }
  ]
}
```

#### 4.2 Script Logic

```javascript
#!/usr/bin/env node
/**
 * Seed user accounts into Cognito User Pool.
 * Usage: node scripts/seed-users.mjs ./seed-users.json
 */

import { CognitoIdentityProviderClient, AdminCreateUserCommand,
  AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { readFileSync } from 'node:fs';

async function seedUsers(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const client = new CognitoIdentityProviderClient({});
  const summary = { created: 0, skipped: 0, errors: [] };

  for (const user of config.users) {
    try {
      // Build user attributes
      const attrs = [
        { Name: 'email', Value: user.email },
        { Name: 'email_verified', Value: 'true' },
      ];
      if (user.attributes) {
        for (const [key, value] of Object.entries(user.attributes)) {
          attrs.push({ Name: key, Value: value });
        }
      }

      // Create user
      await client.send(new AdminCreateUserCommand({
        UserPoolId: config.userPoolId,
        Username: user.email,
        UserAttributes: attrs,
        MessageAction: 'SUPPRESS',
      }));

      // Add to group
      await client.send(new AdminAddUserToGroupCommand({
        UserPoolId: config.userPoolId,
        Username: user.email,
        GroupName: user.group,
      }));

      summary.created++;
      console.log(`✓ Created: ${user.email} → ${user.group}`);
    } catch (err) {
      if (err.name === 'UsernameExistsException') {
        summary.skipped++;
        console.warn(`⚠ Skipped (exists): ${user.email}`);
      } else {
        summary.errors.push({ email: user.email, error: err.message });
        console.error(`✗ Error: ${user.email} — ${err.message}`);
      }
    }
  }

  console.log(`\nSummary: ${summary.created} created, ${summary.skipped} skipped, ${summary.errors.length} errors`);
  return summary;
}
```

### 5. Scanner Mapping Seed

The existing `seed-scanners.mjs` script already creates `SCANNER#scanner-01` through `SCANNER#scanner-10` mappings. For exhibitor Plan B check-ins, we need additional mappings where `scannerId = "station-{stationId}"`:

Add to the default mappings or run with a custom JSON:

```json
[
  { "scannerId": "station-1", "stationId": 1 },
  { "scannerId": "station-2", "stationId": 2 },
  { "scannerId": "station-3", "stationId": 3 },
  { "scannerId": "station-4", "stationId": 4 },
  { "scannerId": "station-5", "stationId": 5 },
  { "scannerId": "station-6", "stationId": 6 },
  { "scannerId": "station-7", "stationId": 7 },
  { "scannerId": "station-8", "stationId": 8 },
  { "scannerId": "station-9", "stationId": 9 },
  { "scannerId": "station-10", "stationId": 10 }
]
```

This ensures the existing `handleCheckin` logic resolves `station-{n}` to the correct stationId without any code changes to the check-in handler.

## Data Models

### DynamoDB Access Patterns

| Access Pattern | PK | SK | Notes |
|---|---|---|---|
| Verify lunch | `TAG#{tagId}` | `LUNCH` | One-time write, idempotent |
| Verify party | `TAG#{tagId}` | `PARTY` | One-time write, idempotent |
| Check lunch status | `TAG#{tagId}` | `LUNCH` | GetItem |
| Check party status | `TAG#{tagId}` | `PARTY` | GetItem |
| Exhibitor scanner lookup | `SCANNER#station-{n}` | `CONFIG` | Existing pattern |

### Verification Record Schema

```
{
  PK: "TAG#{tagId}",
  SK: "LUNCH" | "PARTY",
  tagId: string,
  type: "lunch" | "party",
  verifiedAt: ISO 8601 string,
  verifiedBy: string (staff email)
}
```

### 6. Interfaces

#### POST /verify/lunch

**Request:**
```
POST /verify/lunch
Authorization: Bearer {jwt}
Content-Type: application/json

{ "tagId": "abc123" }
```

**Success Response (200):**
```json
{
  "success": true,
  "tagId": "abc123",
  "type": "lunch",
  "verifiedAt": "2025-07-12T10:30:00.000Z"
}
```

**Already Verified (409):**
```json
{
  "error": "already_verified",
  "message": "Tag abc123 has already been verified for lunch"
}
```

**Forbidden (403):**
```json
{
  "error": "forbidden",
  "message": "Staff or admin group membership required"
}
```

**Missing Field (400):**
```json
{
  "error": "missing_field",
  "message": "Missing required field: tagId",
  "field": "tagId"
}
```

#### POST /verify/party

Identical interface to `/verify/lunch` with `type: "party"` and SK=`PARTY`.

## Testing Strategy

### Unit Tests
- Verify handler: test authorization check, input validation, record creation, idempotence (409 on duplicate)
- Role detection: test token parsing with various group combinations
- Scanner ID derivation: test "station-" prefix concatenation
- Seed script: test config parsing, summary counting, skip-on-exists behavior

### Property Tests
- Verification idempotence: for random tagIds, verify twice → first succeeds, second returns 409
- Group authorization: for random non-staff group combinations, verify returns 403
- Role extraction: for random group arrays, correct role is returned
- Seed summary: for random user lists with mixed outcomes, counts sum to total

### Integration Tests
- End-to-end verification flow with real Cognito tokens
- Exhibitor check-in flow through API Gateway
- Backward compatibility of existing admin routes

## Error Handling

| Scenario | HTTP Status | Error Code | Handler |
|---|---|---|---|
| No JWT (API Gateway rejects) | 401 | unauthorized | API Gateway |
| Valid JWT, wrong group | 403 | forbidden | verify-handler |
| Missing tagId | 400 | missing_field | verify-handler |
| Already verified | 409 | already_verified | verify-handler |
| Race condition (concurrent verify) | 409 | already_verified | DynamoDB ConditionExpression |
| DynamoDB error | 500 | internal_error | verify-handler |

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Verification record creation

*For any* valid tagId and verification type (lunch or party), if no Tag_Record with PK=TAG#{tagId} and SK={TYPE} exists, calling the verify endpoint SHALL create exactly one record with the correct PK, SK, tagId, type, verifiedAt, and verifiedBy fields.

**Validates: Requirements 5.1, 6.1**

### Property 2: Verification idempotence

*For any* tagId and verification type, calling the verify endpoint when a Tag_Record already exists SHALL return a 409 response with error code "already_verified" and SHALL NOT modify the existing record. Equivalently: verify(verify(x)) produces the same stored state as verify(x).

**Validates: Requirements 5.2, 6.2**

### Property 3: Group-based authorization rejection

*For any* JWT claims where the "cognito:groups" field does not contain "staff" or "admin", calling either verification endpoint SHALL return a 403 response with error code "forbidden", regardless of the tagId or request body content.

**Validates: Requirements 5.4, 6.4**

### Property 4: Role extraction from ID token

*For any* valid Cognito ID token payload containing a "cognito:groups" claim, the role detection function SHALL return "staff" if groups contains "staff", "exhibitor" if groups contains "exhibitor", and "participant" otherwise. Priority: staff/admin > exhibitor > participant.

**Validates: Requirements 7.2**

### Property 5: Scanner ID derivation

*For any* string value S representing a custom:stationId, the derived scannerId SHALL equal the string concatenation "station-" + S. This scannerId, when used in a check-in request, SHALL resolve to stationId matching the numeric value of S via the SCANNER#station-{S} DynamoDB record.

**Validates: Requirements 2.5**

### Property 6: Seed script summary correctness

*For any* seed configuration containing N user entries, after execution the summary SHALL report counts where created + skipped + errors = N, and each user is counted in exactly one category.

**Validates: Requirements 9.1, 9.5**
