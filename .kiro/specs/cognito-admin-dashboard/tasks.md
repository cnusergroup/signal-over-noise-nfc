# Implementation Plan: Cognito Admin Dashboard

## Overview

Migrate admin route authentication from Lambda-based API key validation to Cognito JWT authorizer, remove legacy auth code, and build a single-page admin dashboard (admin.html) with embedded Cognito login and management UIs for missions, combos, winners, leaderboard, and station traffic.

## Tasks

- [x] 1. CDK Infrastructure — Cognito & JWT Authorizer
  - [x] 1.1 Add Cognito User Pool, User Pool Client, and JWT Authorizer to CDK stack
    - Import `aws-cdk-lib/aws-cognito` and `HttpJwtAuthorizer` from `aws-cdk-lib/aws-apigatewayv2-authorizers`
    - Create User Pool with email sign-in, self-sign-up disabled, password policy (min 8, lowercase + uppercase + digits)
    - Create User Pool Client with USER_PASSWORD_AUTH and USER_SRP_AUTH flows, no client secret
    - Create `HttpJwtAuthorizer` referencing the Cognito issuer URL and client ID audience
    - Add stack outputs for UserPoolId and UserPoolClientId
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Add Custom Resource to create admin user
    - Use `AwsCustomResource` with `adminCreateUser` SDK call
    - Set email to the configured admin email (via CDK context `adminEmail` / `ADMIN_EMAIL` env var), email_verified to `true`, MessageAction to `SUPPRESS`
    - _Requirements: 1.5_

  - [x] 1.3 Replace Lambda authorizer with JWT authorizer on all admin routes
    - Remove the `HttpLambdaAuthorizer` construct and its import
    - Switch all admin routes (POST/GET/PUT/DELETE /missions/*, POST /combos) to use `jwtAuthorizer`
    - Remove `API_KEY` environment variable from `checkinHandler`
    - Ensure CORS `allowHeaders` includes `Authorization`
    - _Requirements: 2.1, 2.2, 2.3, 2.7, 11.1, 11.4, 11.6_

  - [ ]* 1.4 Write CDK assertion tests for Cognito resources
    - Verify User Pool exists with email sign-in
    - Verify User Pool Client has correct auth flows and no secret
    - Verify JWT Authorizer references correct issuer and audience
    - Verify admin routes use JWT authorizer (not Lambda authorizer)
    - Verify API_KEY env var is absent from Lambda
    - Verify stack outputs include UserPoolId and UserPoolClientId
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.7_

- [x] 2. Lambda Code — Remove Legacy Auth
  - [x] 2.1 Remove API key validation from router and validator
    - In `lambda/checkin/src/router.mjs`: remove `isAdminRoute` function, remove `validateApiKey` import, remove the auth check block in `route()`
    - In `lambda/checkin/src/validator.mjs`: remove the `validateApiKey` function export
    - _Requirements: 2.8, 11.2, 11.3_

  - [x] 2.2 Delete the `.api-key.txt` file from workspace root
    - _Requirements: 11.5_

- [x] 3. Checkpoint — Verify infrastructure changes
  - Ensure CDK synth succeeds and all tests pass, ask the user if questions arise.

- [x] 4. Admin Dashboard — Authentication Module
  - [x] 4.1 Create admin.html with page structure, login view, and Cognito auth logic
    - Create `admin.html` at workspace root (same level as `signal_hunt_checkin_html.html`)
    - Include `amazon-cognito-identity-js` from CDN (unpkg)
    - Implement login form with email and password fields
    - Implement `initCognito()`, `login()`, `completeNewPassword()`, `refreshToken()`, `logout()`, `getIdToken()`, `isAuthenticated()`
    - Handle NEW_PASSWORD_REQUIRED challenge with new password form
    - Store tokens in memory (not localStorage)
    - Display error messages for auth failures (wrong password, network error, too many attempts)
    - Style with dark sci-fi theme matching check-in page (--bg: #050914, glassmorphism panels, Share Tech Mono + Inter fonts)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 10.1, 10.2, 10.3, 10.4_

  - [ ]* 4.2 Write property test for admin API request authorization
    - **Property 1: Admin API requests include JWT token**
    - **Validates: Requirements 3.6**

- [x] 5. Admin Dashboard — API Module & Dashboard Layout
  - [x] 5.1 Implement API request module with JWT token injection and auto-refresh
    - Implement `apiRequest(method, path, body)` with Authorization header for admin endpoints
    - Implement `isAdminEndpoint(method, path)` to identify admin routes
    - On 401: attempt token refresh, retry once; if refresh fails, show login
    - Proactive refresh when token expires within 5 minutes
    - _Requirements: 3.6, 3.7_

  - [x] 5.2 Implement dashboard navigation and section switching
    - Add nav bar with tabs: Overview, Missions, Combos, Winners, Leaderboard, Traffic
    - Implement `showView(viewId)` to toggle login/dashboard
    - Implement `showSection(sectionId)` to show active section
    - Implement loading indicators and error display with retry
    - Make responsive for 375px to 1440px viewports
    - _Requirements: 10.4, 10.5_

- [x] 6. Admin Dashboard — Statistics & Data Views
  - [x] 6.1 Implement statistics panel (Dashboard Overview)
    - Fetch data from GET /stations and GET /leaderboard (public endpoints)
    - Compute and display total check-ins, unique visitors, active missions count, stamp rally completions
    - Show loading indicator while fetching
    - Show error with retry on failure
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 6.2 Write property test for statistics aggregation
    - **Property 2: Statistics aggregation correctness**
    - **Validates: Requirements 4.1**

  - [x] 6.3 Implement leaderboard viewer
    - Fetch from GET /leaderboard
    - Display rank, masked tag ID, elapsed time (formatted as M:SS), completion timestamp
    - Provide refresh action
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ]* 6.4 Write property test for elapsed time formatting
    - **Property 5: Elapsed time formatting**
    - **Validates: Requirements 8.2**

  - [x] 6.5 Implement station traffic viewer
    - Display station traffic summary (unique visitors for all 10 stations)
    - On station select, fetch GET /stations/{stationId} for detailed traffic
    - Provide refresh action
    - _Requirements: 9.1, 9.2, 9.3_

- [x] 7. Admin Dashboard — Mission Management
  - [x] 7.1 Implement mission list view
    - Fetch from GET /missions (admin endpoint with JWT)
    - Display each mission's name, type, station, status, start time, end time
    - Disable edit/delete for active or completed missions
    - _Requirements: 5.1, 5.9_

  - [ ]* 7.2 Write property test for mission actions by status
    - **Property 4: Mission actions disabled by status**
    - **Validates: Requirements 5.9**

  - [x] 7.3 Implement create mission form with type-specific fields
    - Form with type selector (numbered_visit, lucky_draw, early_bird, last_call)
    - Show/hide fields based on selected type (common fields + type-specific)
    - On submit: POST /missions with JWT, add to list on success
    - _Requirements: 5.2, 5.3, 5.4_

  - [ ]* 7.4 Write property test for mission type field mapping
    - **Property 3: Mission type determines visible form fields**
    - **Validates: Requirements 5.3**

  - [x] 7.5 Implement edit and delete mission actions
    - Edit: pre-populate form with existing data, PUT /missions/{missionId}
    - Delete: confirm dialog, DELETE /missions/{missionId}, remove from list
    - Only available for missions with status "scheduled"
    - _Requirements: 5.5, 5.6, 5.7, 5.8_

  - [x] 7.6 Implement winners viewer (per mission)
    - Access from mission list item
    - Fetch GET /missions/{missionId}/winners
    - Display tag ID and award timestamp for each winner
    - Show "no winners" message when empty
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 7.7 Write property test for winner rendering completeness
    - **Property 8: Winner rendering completeness**
    - **Validates: Requirements 7.3**

- [x] 8. Admin Dashboard — Combo Management
  - [x] 8.1 Implement combo list and create form
    - Fetch existing combos from GET /combos on load
    - Display each combo's name, required stations, and reward
    - Create form with name, multi-select stations (1-10), reward description
    - On submit: POST /combos with JWT, add to list on success
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 8.2 Write property test for combo list rendering
    - **Property 7: Combo list rendering completeness**
    - **Validates: Requirements 6.1**

- [ ] 9. Checkpoint — Full integration verification
  - Ensure all tests pass, ask the user if questions arise.

  - [ ]* 9.1 Write property test for mission list rendering
    - **Property 6: Mission list rendering completeness**
    - **Validates: Requirements 5.1**

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The admin.html follows the same single-file pattern as the existing check-in page (inline CSS/JS)
- CDK tests use `aws-cdk-lib/assertions`; property tests use `fast-check` with Vitest
- The JWT authorizer handles all auth at the API Gateway layer — Lambda code no longer needs auth logic

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2"] },
    { "id": 2, "tasks": ["1.4", "4.1"] },
    { "id": 3, "tasks": ["4.2", "5.1"] },
    { "id": 4, "tasks": ["5.2", "6.1", "6.3", "6.5"] },
    { "id": 5, "tasks": ["6.2", "6.4", "7.1"] },
    { "id": 6, "tasks": ["7.2", "7.3", "7.6", "8.1"] },
    { "id": 7, "tasks": ["7.4", "7.5", "7.7", "8.2", "9.1"] }
  ]
}
```
