# Implementation Plan: NFC Check-in Backend

## Overview

This plan transforms the existing basic Lambda + DynamoDB setup into a full-featured NFC check-in backend with mission engine, gamification, and admin API. The implementation progresses from infrastructure and core data layer, through check-in logic and mission processing, to admin endpoints and integration testing. All code uses JavaScript ESM (.mjs) with Vitest for testing and fast-check for property-based tests.

## Tasks

- [x] 1. Restructure project and set up infrastructure
  - [x] 1.1 Set up Lambda project structure and dependencies
    - Restructure `lambda/checkin/` into `src/` modules (router, validator, handlers, mission-engine/, utils/)
    - Create `__tests__/properties/`, `__tests__/unit/`, `__tests__/integration/` directories
    - Update `package.json` to add dependencies: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-scheduler`, `uuid`
    - Add devDependencies: `vitest`, `fast-check`, `@vitest/coverage-v8`
    - Add `vitest.config.mjs` with test configuration
    - Replace `index.mjs` with a thin entry point that imports from `src/router.mjs`
    - _Requirements: All (project foundation)_

  - [x] 1.2 Update CDK stack for single-table DynamoDB design
    - Replace existing `CheckinTable` with single-table design using `PK` (String) and `SK` (String) as keys
    - Add GSI1 with `GSI1PK` (String) partition key and `GSI1SK` (String) sort key
    - Add GSI2 with `GSI2PK` (String) partition key and `GSI2SK` (String) sort key
    - Keep `billingMode: PAY_PER_REQUEST`, `ttl` attribute, and `DESTROY` removal policy
    - _Requirements: 1.1, 3.1, 4.2, 11.1_

  - [x] 1.3 Update CDK stack for API Gateway routes and additional Lambdas
    - Add all API routes: GET /checkin/{tagId}, GET /stations/{stationId}, GET /stations, GET /leaderboard, POST/GET/PUT/DELETE /missions/*, GET /missions/{missionId}/winners, POST/GET /combos
    - Add API key authorization for admin routes (/missions/*, /combos POST)
    - Create Lucky Draw Lambda function (`lambda/lucky-draw/`) triggered by EventBridge
    - Create Last Call Lambda function (`lambda/last-call/`) triggered by EventBridge
    - Grant DynamoDB read/write to all Lambda functions
    - Add EventBridge Scheduler IAM role and permissions
    - Add CORS support for all methods (GET, POST, PUT, DELETE)
    - _Requirements: 1.8, 5.4, 9.4, 9.6, 10.1, 10.9_

  - [x] 1.4 Implement shared utility modules
    - Create `src/utils/dynamo.mjs` — DynamoDB client singleton, helper for building key expressions
    - Create `src/utils/time.mjs` — injectable clock (for testing), TTL calculator, ISO timestamp helpers
    - Create `src/utils/crypto.mjs` — reward code generator (16+ chars, crypto.randomBytes), masked tag ID formatter
    - Create `src/utils/response.mjs` — standardized JSON response builder with error format
    - _Requirements: 6.3, 8.2, 11.1, 11.2_

- [x] 2. Implement core check-in logic
  - [x] 2.1 Implement request router and validator
    - Create `src/router.mjs` — route dispatcher matching method + path to handler functions
    - Create `src/validator.mjs` — input validation for all endpoints (tagId, scannerId, stationId range, mission params)
    - Router must handle: POST /checkin, GET /checkin/{tagId}, GET /stations/{stationId}, GET /stations, GET /leaderboard, POST/GET/PUT/DELETE /missions/*, GET /missions/{missionId}/winners, POST/GET /combos
    - Admin routes must validate API key from Authorization header before dispatching
    - _Requirements: 1.3, 1.6, 10.9_

  - [x] 2.2 Implement check-in handler with cooldown and tag validation
    - Create `src/checkin-handler.mjs`
    - Validate tagId and scannerId presence (400 if missing)
    - Look up scanner-to-station mapping from DynamoDB (`SCANNER#{scannerId}`, `CONFIG`)
    - Validate NFC tag exists in registry (`TAG#{tagId}`, `REGISTRY`) — 404 if not found
    - Check existing check-in record (`TAG#{tagId}`, `CHECKIN#{stationId}`) for cooldown (30s)
    - If cooldown active: return 429 with remainingSeconds, still evaluate missions
    - If cooldown expired or first visit: PutItem with new timestamp, set TTL, evaluate missions
    - Return success response with tagId, stationId, checkinTime, and missions object
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 11.1_

  - [ ]* 2.3 Write property tests for check-in validation (Properties 1–5)
    - **Property 1: Check-in record creation round trip** — verify response contains correct tagId, stationId (1–10), valid ISO 8601 timestamp
    - **Property 2: Missing field validation** — for any missing/empty tagId or scannerId, returns 400 identifying the field
    - **Property 3: Unregistered tag rejection** — any tag not in registry returns 404
    - **Property 4: Cooldown remaining time calculation** — 429 with remainingSeconds = 30 - floor(T2 - T1)
    - **Property 5: Invalid scanner rejection** — scanner not mapping to station 1–10 returns 400
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6**

  - [ ]* 2.4 Write unit tests for check-in handler
    - Test successful check-in creates record and returns 200
    - Test cooldown rejection returns 429 with correct remaining seconds
    - Test internal DynamoDB failure returns 500 without partial record
    - Test concurrent check-in handling (conditional write failure)
    - _Requirements: 1.1, 1.5, 1.7_

- [x] 3. Implement progress and station queries
  - [x] 3.1 Implement progress query handler
    - Create `src/progress-handler.mjs`
    - Query all check-ins for tag: PK = `TAG#{tagId}`, SK begins_with `CHECKIN#`
    - Filter out expired records (TTL < current time)
    - Return stations sorted by stationId ascending, totalCheckins, completed boolean
    - If stamp rally complete, include rewardCode from stamp rally record
    - Validate tagId is non-empty (return error if empty/whitespace)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 11.4_

  - [x] 3.2 Implement station traffic handler
    - Create `src/station-handler.mjs`
    - GET /stations/{stationId}: Query GSI1 with `STATION#{stationId}`, return unique visitors count and up to 1000 timestamps descending
    - GET /stations: Query all stations 1–10, return summary with unique visitor counts
    - Validate stationId is integer 1–10 (return error without querying if invalid)
    - Filter out expired records (TTL < current time)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 11.4_

  - [ ]* 3.3 Write property tests for progress and station queries (Properties 6–10)
    - **Property 6: Progress query correctness** — stations sorted ascending, totalCheckins = |S|, completed = (|S| == 10)
    - **Property 7: Progress query input validation** — empty/whitespace tagId returns error
    - **Property 8: Station traffic sort order and limit** — timestamps descending, limited to min(N, 1000)
    - **Property 9: Station summary aggregation** — 10 entries, each with correct unique visitor count
    - **Property 10: Station identifier validation** — non-integer or out-of-range returns error without DB query
    - **Validates: Requirements 2.1, 2.2, 2.4, 3.1, 3.2, 3.3**

- [x] 4. Checkpoint - Core check-in and queries
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement mission engine - Numbered Visit
  - [x] 5.1 Implement mission evaluator orchestrator
    - Create `src/mission-engine/evaluator.mjs`
    - Query active missions for the station (by type and time window)
    - Orchestrate calls to individual mission processors
    - Aggregate results into missions response object
    - Handle graceful degradation: if a mission processor fails, check-in still succeeds with `missionErrors` field
    - _Requirements: 4.2, 4.7, 5.3, 9.2_

  - [x] 5.2 Implement numbered visit processor
    - Create `src/mission-engine/numbered-visit.mjs`
    - Check if tag already has entry (`MISSION#{missionId}`, `ENTRY#{tagId}`) — return existing number if so
    - If first visit: atomic increment counter (`MISSION#{missionId}`, `COUNTER`) using DynamoDB ADD
    - Write entry with assigned visitor number (conditional PutItem)
    - Check if visitor number matches any milestone in mission config
    - Return visitorNumber, isMilestone, milestoneMessage
    - Handle concurrent access: atomic counter guarantees uniqueness
    - _Requirements: 4.2, 4.3, 4.4, 4.6, 4.7_

  - [ ]* 5.3 Write property tests for numbered visit (Properties 11–14)
    - **Property 11: Sequential uniqueness** — N distinct tags produce exactly {1, 2, ..., N} with no duplicates/gaps
    - **Property 12: Idempotency** — tag with existing number always returns same number without incrementing
    - **Property 13: Milestone detection** — milestone notification iff visitorNumber ∈ milestones list
    - **Property 14: Independent mission counters** — two simultaneous missions maintain separate counters
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.6, 4.7**

- [x] 6. Implement mission engine - Lucky Draw and Early Bird/Last Call
  - [x] 6.1 Implement lucky draw recorder
    - Create `src/mission-engine/lucky-draw.mjs`
    - During active mission: record eligible entry (`MISSION#{missionId}`, `ENTRY#{tagId}`) with conditional PutItem (one entry per tag per mission)
    - Return acknowledgment that entry was recorded (or already exists)
    - _Requirements: 5.3_

  - [x] 6.2 Implement lucky draw winner selection Lambda
    - Create `lambda/lucky-draw/index.mjs`
    - Triggered by EventBridge at mission end time
    - Query all entries for mission, randomly select N winners using crypto.randomInt
    - Write winner records (`MISSION#{missionId}`, `WINNER#{tagId}`)
    - Update mission status to completed
    - Handle case where entries < N (select all as winners)
    - _Requirements: 5.4, 5.5, 5.6_

  - [x] 6.3 Implement early bird processor
    - Create `src/mission-engine/early-bird.mjs`
    - Check if tag already has early bird slot for this mission — if so, return existing bonus without re-awarding
    - Atomic increment counter to determine position
    - If position ≤ N: write early bird slot (`MISSION#{missionId}`, `EARLYBIRD#{position}`), return bonus
    - If position > N: mission full, no bonus
    - Transition mission to completed state when N winners recorded
    - _Requirements: 9.2, 9.5, 9.7, 9.8_

  - [x] 6.4 Implement last call recorder and finalization Lambda
    - Create `src/mission-engine/last-call.mjs` — maintain sliding window by writing/updating `LASTCALL#{tagId}` entries with timestamp
    - Create `lambda/last-call/index.mjs` — triggered by EventBridge at mission end time
    - Query last call entries, sort by timestamp descending, select last N unique tags as winners
    - Write winner records, update mission status
    - Handle case where entries < N
    - _Requirements: 9.4, 9.6, 9.7_

  - [ ]* 6.5 Write property tests for lucky draw and early bird/last call (Properties 15–17, 23–24)
    - **Property 15: Lucky draw validation** — invalid N, times, or description rejected with error
    - **Property 16: Lucky draw entry uniqueness** — multiple check-ins produce exactly one entry per tag per mission
    - **Property 17: Lucky draw winner selection with insufficient entries** — E < N selects all E as winners
    - **Property 23: Early bird first-N award with idempotency** — exactly first N unique tags get bonus, repeats don't re-award or consume slots
    - **Property 24: Last call sliding window** — winners are last N unique tags by timestamp
    - **Validates: Requirements 5.2, 5.3, 5.6, 9.2, 9.4, 9.5, 9.7, 9.8**

- [x] 7. Implement stamp rally, combo, and leaderboard
  - [x] 7.1 Implement stamp rally evaluator
    - Create `src/mission-engine/stamp-rally.mjs`
    - After check-in: query all check-ins for tag, check if all 10 stations visited
    - If complete and no existing stamp rally record: generate reward code (crypto, 16+ chars), write `TAG#{tagId}`, `STAMPRALLY` record
    - If already complete: return existing reward code
    - Include completion status in check-in response
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 7.2 Implement combo evaluator
    - Create `src/mission-engine/combo.mjs`
    - After check-in: query all combos (GSI1 `COMBO_LIST`), check if tag's visited stations are superset of any combo's required stations
    - For each newly completed combo: write award record (`TAG#{tagId}`, `COMBO#{comboName}`) with conditional PutItem (at-most-once)
    - Return list of newly completed combos in response
    - _Requirements: 7.3, 7.4, 7.5_

  - [x] 7.3 Implement leaderboard handler and updater
    - Create `src/leaderboard-handler.mjs`
    - GET /leaderboard: Query PK = `LEADERBOARD`, SK begins_with `ENTRY#`, limit 20, return masked tagIds and elapsed seconds
    - Create leaderboard update logic in stamp rally evaluator: on completion, calculate elapsed = max(timestamps) - min(timestamps) in seconds, write `LEADERBOARD`, `ENTRY#{elapsedSeconds}#{tagId}`
    - Sort by elapsed ascending, ties broken by completion timestamp
    - Mask tagId: first 4 + "****" + last 4 characters
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 7.4 Write property tests for stamp rally, combo, and leaderboard (Properties 18–22)
    - **Property 18: Stamp rally completion and idempotency** — reward code generated once (16+ chars), same code returned on subsequent queries
    - **Property 19: Combo detection and at-most-once award** — combo triggered iff stations become superset for first time, no re-trigger
    - **Property 20: Combo validation** — station outside 1–10 or duplicates rejected
    - **Property 21: Leaderboard elapsed time calculation** — elapsed = max(timestamps) - min(timestamps) in whole seconds (truncated)
    - **Property 22: Leaderboard sort order** — at most 20 entries, ascending elapsed, ties by earlier completion
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 7.2, 7.3, 7.4, 8.1, 8.2**

- [x] 8. Checkpoint - Mission engine complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement admin API
  - [x] 9.1 Implement mission admin handler (CRUD)
    - Create `src/admin-handler.mjs`
    - POST /missions: validate params (type, name ≤200 chars, startTime < endTime, type-specific fields), create mission record + counter, schedule EventBridge rule for lucky draw/last call end times, return 201
    - GET /missions: list all missions with id, name, type, status
    - GET /missions/{missionId}: return full mission config and status
    - PUT /missions/{missionId}: validate mission hasn't started (409 if active/ended), apply updates
    - DELETE /missions/{missionId}: validate mission hasn't started (409 if active/ended), remove record, return 204
    - GET /missions/{missionId}/winners: query winner records, return list
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.10_

  - [x] 9.2 Implement combo admin handler
    - Create `src/combo-handler.mjs`
    - POST /combos: validate name (≤100 chars), stations (2–10, no duplicates, all 1–10), reward (≤200 chars), write combo config
    - GET /combos: query GSI1 `COMBO_LIST`, return all combo configurations
    - _Requirements: 7.1, 7.2, 7.6_

  - [ ]* 9.3 Write property tests for admin API (Properties 25–27)
    - **Property 25: Mission lifecycle state transitions** — PUT/DELETE succeed only when current time < start time, reject with 409 otherwise
    - **Property 26: Mission parameter validation** — missing fields, end ≤ start, name > 200 chars rejected with 400
    - **Property 27: Admin authentication enforcement** — invalid/missing API key returns 401
    - **Validates: Requirements 10.4, 10.5, 10.6, 10.7, 10.8, 10.9**

  - [ ]* 9.4 Write unit tests for admin handlers
    - Test mission CRUD happy paths
    - Test combo creation with valid/invalid station sets
    - Test 404 for non-existent mission
    - Test EventBridge scheduler creation on lucky draw/last call mission creation
    - _Requirements: 10.1, 10.2, 10.10, 7.1, 7.2_

- [x] 10. Implement data expiration and TTL filtering
  - [x] 10.1 Implement TTL setting and expired record filtering
    - Ensure all check-in writes set TTL = floor(creationTime/1000) + 30*24*60*60
    - Ensure all mission writes set TTL = floor(endTime/1000) + 30*24*60*60
    - Add TTL filter to all query operations: exclude items where `ttl` < current Unix epoch
    - Update progress, station, leaderboard, and mission queries to apply TTL filter
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 10.2 Write property tests for TTL (Properties 28–29)
    - **Property 28: TTL calculation** — check-in TTL = floor(T/1000) + 30*86400; mission TTL = floor(E/1000) + 30*86400
    - **Property 29: Expired record filtering** — records with TTL < current time excluded from all queries
    - **Validates: Requirements 11.1, 11.2, 11.4**

- [x] 11. Integration wiring and final assembly
  - [x] 11.1 Wire all components together in router and entry point
    - Update `lambda/checkin/index.mjs` to import and delegate to `src/router.mjs`
    - Ensure router correctly dispatches all routes to their handlers
    - Verify mission engine is called from check-in handler with correct parameters
    - Verify admin auth middleware is applied to protected routes
    - Ensure all environment variables (TABLE_NAME, API_KEY, etc.) are read correctly
    - _Requirements: 1.1, 1.8, 10.9_

  - [x] 11.2 Create seed data scripts and scanner mapping configuration
    - Create script to seed NFC tag registry records (`TAG#{tagId}`, `REGISTRY`)
    - Create script to seed scanner-to-station mappings (`SCANNER#{scannerId}`, `CONFIG`)
    - Document required environment variables and configuration
    - _Requirements: 1.4, 1.6_

  - [ ]* 11.3 Write integration tests for end-to-end flows
    - Test full check-in flow: scanner lookup → tag validation → cooldown check → record creation → mission evaluation
    - Test progress query returns correct data after multiple check-ins
    - Test stamp rally completion triggers reward code and leaderboard entry
    - Test combo detection across multiple check-ins
    - Test admin mission CRUD lifecycle
    - Use mocked DynamoDB client or DynamoDB Local
    - _Requirements: 1.1, 2.1, 6.1, 7.3, 8.1, 10.1_

- [x] 12. Final checkpoint - All tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The existing `index.mjs` and CDK stack will be significantly refactored (not extended) to match the single-table design
- All Lambda code uses JavaScript ESM (.mjs) with `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb`
- Testing uses Vitest as runner and fast-check for property-based tests
- EventBridge Scheduler is used for deferred processing (lucky draw selection, last call finalization)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.4"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "2.2"] },
    { "id": 3, "tasks": ["2.3", "2.4", "3.1", "3.2"] },
    { "id": 4, "tasks": ["3.3", "5.1"] },
    { "id": 5, "tasks": ["5.2", "6.1", "6.3", "6.4"] },
    { "id": 6, "tasks": ["5.3", "6.2", "6.5"] },
    { "id": 7, "tasks": ["7.1", "7.2", "7.3"] },
    { "id": 8, "tasks": ["7.4", "9.1", "9.2"] },
    { "id": 9, "tasks": ["9.3", "9.4", "10.1"] },
    { "id": 10, "tasks": ["10.2", "11.1", "11.2"] },
    { "id": 11, "tasks": ["11.3"] }
  ]
}
```
