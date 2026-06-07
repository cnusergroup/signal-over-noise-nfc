# Implementation Plan: Role-Based Scan System

## Overview

Extend the Signal Hunt NFC check-in system to support role-differentiated scan behaviors. Authenticated exhibitors auto-check-in participants at their assigned station. Authenticated staff access a verification panel for one-time lunch/party eligibility. Unauthenticated participants see the existing progress page unchanged. Implementation spans CDK infrastructure (Cognito groups, custom attributes, new API routes), a new Lambda verify handler, frontend role detection with Cognito Identity JS, and a user seed script.

## Tasks

- [ ] 1. CDK Infrastructure — Cognito groups, custom attribute, and new API routes
  - [ ] 1.1 Add Cognito User Pool groups (admin, exhibitor, staff) to the existing stack
    - Create three `CfnUserPoolGroup` constructs on the existing `AdminUserPool`
    - Groups: "admin", "exhibitor", "staff" with descriptions
    - _Requirements: 1.1_

  - [ ] 1.2 Add custom:stationId attribute via AwsCustomResource
    - Use `cr.AwsCustomResource` with `addCustomAttributes` SDK call
    - Attribute: String type, mutable, min 1 / max 10 length
    - _Requirements: 1.3_

  - [ ] 1.3 Add JWT-protected /verify/lunch and /verify/party API routes
    - Add two `httpApi.addRoutes` calls with POST method, `checkinIntegration`, and `jwtAuthorizer`
    - Paths: `/verify/lunch` and `/verify/party`
    - _Requirements: 5.1, 5.3, 6.1, 6.3, 10.3_

- [ ] 2. Lambda — Verify handler and router wiring
  - [ ] 2.1 Create verify-handler.mjs with handleVerify function
    - Implement `isStaffOrAdmin(claims)` helper to check cognito:groups claim
    - Implement `handleVerify({ type, body, claims })` with authorization check, input validation, idempotent DynamoDB write with ConditionExpression, and proper error responses (403, 400, 409, 200)
    - Use existing `utils/dynamo.mjs` and `utils/response.mjs` patterns
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 6.1, 6.2, 6.4, 6.5_

  - [ ] 2.2 Add /verify/lunch and /verify/party routes to router.mjs
    - Add `extractClaims(event)` helper to pull JWT claims from `event.requestContext.authorizer.jwt.claims`
    - Add route matching for `POST /verify/lunch` and `POST /verify/party` before the catch-all 404
    - Import and call `handleVerify` from verify-handler.mjs
    - _Requirements: 5.1, 6.1_

  - [ ]* 2.3 Write property test: Verification record creation (Property 1)
    - **Property 1: Verification record creation**
    - For any valid tagId and type, if no record exists, verify creates exactly one record with correct fields
    - **Validates: Requirements 5.1, 6.1**

  - [ ]* 2.4 Write property test: Verification idempotence (Property 2)
    - **Property 2: Verification idempotence**
    - For any tagId and type, calling verify when record exists returns 409 and does not modify existing record
    - **Validates: Requirements 5.2, 6.2**

  - [ ]* 2.5 Write property test: Group-based authorization rejection (Property 3)
    - **Property 3: Group-based authorization rejection**
    - For any JWT claims without "staff" or "admin" in cognito:groups, verify returns 403 regardless of body
    - **Validates: Requirements 5.4, 6.4**

- [ ] 3. Checkpoint — Verify backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Frontend — Role detection and conditional UI rendering
  - [ ] 4.1 Add Cognito Identity JS SDK and role detection logic to signal_hunt.html
    - Add `<script>` tag for amazon-cognito-identity-js CDN bundle
    - Implement `detectRole()` function that checks localStorage session, extracts ID token, reads cognito:groups claim
    - Return role object: `{ role: 'participant'|'exhibitor'|'staff', session, jwt, stationId }`
    - Priority: staff/admin > exhibitor > participant
    - _Requirements: 7.1, 7.2, 7.5, 8.1, 8.2, 8.3, 8.4_

  - [ ] 4.2 Implement exhibitor scan interface in the popup
    - When role is "exhibitor", replace popup content with simplified scan UI
    - Show station name header derived from custom:stationId
    - On tagId detection from URL, auto-call POST /checkin with scannerId = "station-{stationId}"
    - Display success/error messages in the popup
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 7.3_

  - [ ] 4.3 Implement staff verification interface in the popup
    - When role is "staff", replace popup content with verification panel
    - Show tagId (auto-detected from URL or manual input)
    - Show "Verify Lunch" and "Verify Party" buttons
    - Call POST /verify/lunch or /verify/party with JWT Authorization header
    - Display result indicators: ✓ verified, ⚠ already verified, ✗ error
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 7.4_

  - [ ] 4.4 Preserve participant default behavior when no session exists
    - When `detectRole()` returns "participant", call existing `showInfoPopup()` unchanged
    - Ensure no regressions to existing progress display, station map, or modal behavior
    - _Requirements: 4.1, 4.2, 10.1_

  - [ ]* 4.5 Write property test: Role extraction from ID token (Property 4)
    - **Property 4: Role extraction from ID token**
    - For any valid cognito:groups claim array, role detection returns correct role with priority staff/admin > exhibitor > participant
    - **Validates: Requirements 7.2**

  - [ ]* 4.6 Write property test: Scanner ID derivation (Property 5)
    - **Property 5: Scanner ID derivation**
    - For any string S as custom:stationId, derived scannerId equals "station-" + S
    - **Validates: Requirements 2.5**

- [ ] 5. Checkpoint — Verify frontend integration works end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Seed scripts — User provisioning and scanner mappings
  - [ ] 6.1 Create seed-users.mjs script for Cognito user provisioning
    - Accept JSON config file path as CLI argument
    - For each user: AdminCreateUser with email + attributes, AdminAddUserToGroup
    - Handle UsernameExistsException by skipping with warning
    - Output summary: created, skipped, errors counts
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ] 6.2 Add station-{n} scanner mappings to seed-scanners.mjs or create a JSON config
    - Add 10 station-based scanner mappings (station-1 through station-10) so exhibitor check-ins resolve correctly
    - Can be a separate JSON file passed to the existing seed-scanners.mjs script
    - _Requirements: 2.5_

  - [ ]* 6.3 Write property test: Seed script summary correctness (Property 6)
    - **Property 6: Seed script summary correctness**
    - For any seed config with N users, summary counts (created + skipped + errors) = N
    - **Validates: Requirements 9.1, 9.5**

- [ ] 7. Final checkpoint — Full integration verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The project uses Vitest for testing (see `lambda/checkin/vitest.config.mjs`)
- CDK infrastructure is TypeScript; Lambda handlers are Node.js ESM (.mjs)
- Frontend is vanilla HTML/JS — no build step required
- The existing `seed-scanners.mjs` already supports custom JSON input, so station mappings can be added via a JSON file

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "6.1", "6.2"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "6.3"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 5, "tasks": ["4.5", "4.6"] }
  ]
}
```
