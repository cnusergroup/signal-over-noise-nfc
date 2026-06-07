# Implementation Plan: After Party Lottery

## Overview

This plan extends the existing Signal Over Noise NFC check-in system with the After Party Lottery feature. The backend reuses the single `CheckinHandler` Lambda and the single DynamoDB table, augmenting the existing check-in and progress handlers and adding a new lottery handler module. The frontend introduces a standalone `lottery.html` 3D animation page (Three.js) and a new lottery panel inside the existing `signal_hunt.html` Progress Page. The implementation progresses from configuration and time-gate logic, through backend handlers and routing, to the Three.js scene and progress-page integration, with property-based tests interleaved next to each implementation step.

All backend code uses JavaScript ESM (`.mjs`) with Vitest + fast-check + `aws-sdk-client-mock`, matching the conventions of the existing `nfc-checkin-backend` workspace. Infrastructure changes are TypeScript CDK in `infra/lib/signal-hunt-stack.ts`. Frontend lottery-page modules live under `web/lottery/` as ES modules and are tested with Vitest + JSDOM (for DOM properties) or a Node environment (for pure helpers and Three.js scene-graph data).

Each property test task is annotated with its design-document property number and the requirements clauses it validates, and every test file SHALL include a header comment of the form `// Feature: after-party-lottery, Property {N}: {title}`.

## Tasks

- [x] 1. Configuration and infrastructure
  - [x] 1.1 Add time-gate helpers to `lambda/checkin/src/utils/time.mjs`
    - Export `getAfterPartyTimeGateMs()` that reads `process.env.AFTER_PARTY_TIME_GATE` (default `2026-06-28T09:00:00Z`), parses with `Date.parse`, caches the result, and throws an `Error` whose message names the malformed value if `Date.parse` returns `NaN`
    - Export `isAfterPartyCheckin(timestamp)` accepting either an ISO 8601 string or a Unix-ms number and returning `timestamp >= getAfterPartyTimeGateMs()`
    - Reuse the existing injectable clock helper for `now()` so tests can override the current time
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Update CDK stack with env var, JWT-protected lottery routes, and public lottery routes
    - In `infra/lib/signal-hunt-stack.ts`, add `AFTER_PARTY_TIME_GATE='2026-06-28T09:00:00Z'` to the `CheckinHandler` Lambda environment
    - Add four HTTP API routes reusing the existing `checkinIntegration`: `POST /lottery/nickname` (public), `GET /lottery/participants` (public), `POST /lottery/draw` (JWT authorizer, `admin` group), `GET /lottery/winners` (JWT authorizer, `admin` group)
    - Ensure CORS configuration covers the new methods on the new paths
    - Preserve all existing routes and authorizers unchanged
    - _Requirements: 1.3, 4.5, 5.6_

  - [x]* 1.3 Write property test for time-gate classification
    - **Property 1: Time gate classification**
    - Create `lambda/checkin/__tests__/properties/lottery-time-gate.property.test.mjs`
    - Use `fast-check` to generate arbitrary integer Unix-ms timestamps and arbitrary ISO 8601 strings as `AFTER_PARTY_TIME_GATE`; assert `isAfterPartyCheckin(T) === (T >= Date.parse(G))`
    - Add a separate property: for any string `G` where `Number.isNaN(Date.parse(G))`, importing the module after setting that env var SHALL throw an `Error` whose message contains `G`
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

- [x] 2. Augment check-in handler with `afterParty` flag
  - [x] 2.1 Persist `afterParty` boolean on every newly written check-in record
    - In `lambda/checkin/src/checkin-handler.mjs`, import `isAfterPartyCheckin` from `utils/time.mjs`
    - When constructing the `PutCommand` Item for a new check-in, add `afterParty: isAfterPartyCheckin(currentTime)`
    - Do NOT modify cooldown-rejected or pre-existing records (the flag is stamped only on successful writes)
    - Preserve all existing fields, GSI keys, and TTL behavior unchanged
    - _Requirements: 1.1, 1.2, 1.6_

  - [x]* 2.2 Write unit test for `afterParty` stamping
    - Create `lambda/checkin/__tests__/unit/checkin-after-party.test.mjs`
    - Mock DynamoDB with `aws-sdk-client-mock`; stub the clock to return a time before and after the gate; assert the captured `PutCommand` Item has `afterParty: false` for pre-gate writes and `afterParty: true` for post-gate writes
    - Assert that cooldown-rejected requests do NOT issue a `PutCommand` and therefore cannot mutate `afterParty`
    - _Requirements: 1.1, 1.2, 1.6_

- [x] 3. Augment progress handler with lottery fields
  - [x] 3.1 Add `afterPartyEligible`, `lotteryEligible`, `lotteryReason`, and `nickname` to the progress response
    - In `lambda/checkin/src/progress-handler.mjs`, after computing `validCheckins` and `completed`, derive `afterPartyEligible = validCheckins.some(r => r.afterParty === true)`
    - Compute `beforeGate = now() < getAfterPartyTimeGateMs()` and only attach `lotteryEligible` / `lotteryReason` when `!beforeGate` (Requirement 2.5)
    - Map eligibility to one of the four `lotteryReason` machine-readable strings: `incomplete_stations_and_no_after_party_checkin`, `incomplete_stations`, `after_party_checkin_required`, or no reason when eligible
    - Issue a `GetCommand` for `TAG#{tagId} / NICKNAME` (best-effort, log and ignore on error) and include `nickname` in the response when present
    - Add `stationsRemaining = completed ? 0 : (TOTAL_STATIONS - totalCheckins)` to the response
    - _Requirements: 1.5, 2.1, 2.2, 2.3, 2.5, 3.8_

  - [x]* 3.2 Write property test for after-party eligibility derivation
    - **Property 2: After-party eligibility derivation**
    - Create `lambda/checkin/__tests__/properties/lottery-eligibility.property.test.mjs`
    - Generate arbitrary sets of check-in records (varying `afterParty` flags) seeded into the `aws-sdk-client-mock` DynamoDB; assert the progress response's `afterPartyEligible === records.some(r => r.afterParty === true)`
    - **Validates: Requirements 1.5, 1.6**

  - [x]* 3.3 Write property test for lottery eligibility computation
    - **Property 3: Lottery eligibility computation**
    - Append to `lambda/checkin/__tests__/properties/lottery-eligibility.property.test.mjs`
    - Generate arbitrary `(currentTime, recordSet)` pairs; assert the response fields `lotteryEligible`, `lotteryReason`, `stationsRemaining` exactly match the four-branch specification function from the design (including omission of `lotteryEligible` when `currentTime < timeGate`)
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.5**

- [x] 4. Implement nickname validator and registration
  - [x] 4.1 Add nickname format validator
    - Add `validateNickname(s)` to `lambda/checkin/src/validator.mjs` (or create `lottery-validator.mjs`) returning `{ ok: true }` or `{ ok: false, code: 'invalid_field' | 'missing_field', message }`
    - Reject when `s` is missing, not a string, length 0 after trim, length > 20, has leading or trailing whitespace (`s !== s.replace(/^\s+|\s+$/g, '')`), or contains any character whose Unicode general category is `Cc` (control character)
    - Accept all other Unicode printable characters including CJK, emoji, and combining marks
    - _Requirements: 3.1, 3.4_

  - [x] 4.2 Implement `handleNicknameRegister` in `lambda/checkin/src/lottery-handler.mjs` (new file)
    - Create the `lottery-handler.mjs` module and export `handleNicknameRegister(body)`
    - Validate body shape (`tagId` non-empty trimmed string, `nickname` via `validateNickname`); on failure return 400 `invalid_field` or `missing_field`
    - If `now() < getAfterPartyTimeGateMs()`, return 403 `lottery_not_open`
    - Query `TAG#{tagId}` SK begins-with `CHECKIN#`; verify 10 distinct station IDs AND at least one record with `afterParty === true`; on failure return 403 `not_eligible`
    - Issue a `TransactWriteCommand` with two conditional `Put` items: `TAG#{tagId}/NICKNAME` (`attribute_not_exists(PK)`) and `NICKNAME#{nickname}/RESERVED` (`attribute_not_exists(PK)`, with `GSI1PK='NICKNAME_LIST'` and `GSI1SK={nickname}`)
    - On `TransactionCanceledException`, inspect `CancellationReasons[i].Code === 'ConditionalCheckFailed'`: index 0 → 409 `already_registered`; index 1 → 409 `nickname_taken`
    - On success return 200 `{ tagId, nickname, registeredAt }`; on unrecognized DynamoDB errors return 500 `internal_error`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x]* 4.3 Write property test for nickname format validator
    - **Property 4: Nickname format validator**
    - Create `lambda/checkin/__tests__/properties/lottery-nickname.property.test.mjs`
    - Use `fc.string()` with various filters (empty, whitespace-padded, length > 20, containing control characters) and assert acceptance iff length 1–20, no leading/trailing whitespace, all characters are non-`Cc`
    - **Validates: Requirements 3.1, 3.4, 10.1**

  - [x]* 4.4 Write property test for nickname registration round-trip
    - **Property 5: Nickname registration round-trip**
    - Append to `lottery-nickname.property.test.mjs`
    - For any eligible tag and valid nickname, after a successful `POST /lottery/nickname`, asserting that a subsequent `GET /checkin/{tagId}` returns the same `nickname` value
    - Use the in-memory `aws-sdk-client-mock` store seeded with 10 distinct station check-ins (one with `afterParty: true`)
    - **Validates: Requirements 3.1, 3.8**

  - [x]* 4.5 Write property test for nickname uniqueness (case-sensitive)
    - **Property 6: Nickname uniqueness (case-sensitive)**
    - Append to `lottery-nickname.property.test.mjs`
    - For any pair of distinct eligible tags `(t1, t2)` and any valid nickname `n`, registering `(t1, n)` returns 200 and registering `(t2, n)` returns 409 `nickname_taken`
    - For any case-different pair `(n1, n2)` (e.g. `Alice` vs `alice`), both registrations succeed with 200
    - **Validates: Requirements 3.2, 3.3**

  - [x]* 4.6 Write property test for ineligible registration rejection
    - **Property 7: Ineligible registration rejection**
    - Append to `lottery-nickname.property.test.mjs`
    - For any combination of `(beforeGate, distinctStationCount, hasAfterPartyCheckin)` that fails the eligibility predicate, assert the request returns 403 and the in-memory DynamoDB store contains zero new `NICKNAME` items afterwards
    - **Validates: Requirements 3.5, 3.6**

  - [x]* 4.7 Write property test for tag-level registration idempotence
    - **Property 8: Tag-level registration idempotence**
    - Append to `lottery-nickname.property.test.mjs`
    - For any eligible tag and any pair of valid nicknames `(n1, n2)`, after a successful registration with `n1`, a second registration request with `n2` returns 409 `already_registered` and the persisted nickname for the tag remains `n1`
    - **Validates: Requirements 3.7**

- [x] 5. Implement participants list, draw, and winners endpoints
  - [x] 5.1 Implement `handleListParticipants`
    - Add `handleListParticipants()` export to `lambda/checkin/src/lottery-handler.mjs`
    - Issue a `QueryCommand` against GSI1 with `GSI1PK = 'NICKNAME_LIST'`, returning all reserved nickname records
    - Map each item to `{ nickname }` (do NOT return `tagId` to preserve attendee privacy)
    - Return 200 `{ count: items.length, participants: [...] }`
    - On any DynamoDB error return 500 `internal_error`; require no authentication
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6_

  - [x] 5.2 Implement `handleDraw`
    - Add `handleDraw(claims)` export to `lottery-handler.mjs`
    - Reject with 403 `forbidden` when `claims['cognito:groups']` does not include `admin` (API Gateway already enforces 401 for missing/invalid JWT)
    - Re-query the participant list using the same GSI1 query as `handleListParticipants`; if empty, return 400 `no_participants`
    - Issue an `UpdateCommand` on `LOTTERY/DRAW_COUNTER` with `UpdateExpression: 'ADD seq :one'` and `ReturnValues: 'UPDATED_NEW'` to obtain a unique `drawSeq`
    - Use `crypto.randomInt(0, participants.length)` to pick the winner index; persist the result as `LOTTERY/WINNER#{paddedSeq}` where `paddedSeq = String(drawSeq).padStart(6, '0')`
    - Return 200 `{ drawSeq, nickname, tagId, drawnAt }`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.7_

  - [x] 5.3 Implement `handleListWinners`
    - Add `handleListWinners(claims)` export to `lottery-handler.mjs`
    - Reject with 403 `forbidden` when `claims['cognito:groups']` does not include `admin`
    - `Query` `PK = 'LOTTERY'`, `SK begins_with 'WINNER#'`, `ScanIndexForward: true` so results are chronological by zero-padded sequence number
    - Return 200 `{ count, winners: [{ drawSeq, nickname, tagId, drawnAt }, ...] }`; for zero results return `{ count: 0, winners: [] }`
    - _Requirements: 5.5, 5.8_

  - [x]* 5.4 Write property test for participant list shape
    - **Property 9: Participant list shape**
    - Create `lambda/checkin/__tests__/properties/lottery-participants.property.test.mjs`
    - Generate sets of completed registrations of arbitrary size 0..200; assert response `count === |R|`, `participants.length === |R|`, and the multiset of returned nicknames equals the registered multiset; assert the empty case returns `count: 0, participants: []`
    - **Validates: Requirements 4.1, 4.2, 4.4**

  - [x]* 5.5 Write property test for draw selection invariants
    - **Property 10: Draw selection invariants**
    - Create `lambda/checkin/__tests__/properties/lottery-draw.property.test.mjs`
    - For any non-empty pool `P` and `K >= 1` sequential draws, every returned winner nickname is in `P`, and `GET /lottery/participants` returns the same multiset before and after; for `P = ∅` the draw returns 400 `no_participants`
    - **Validates: Requirements 5.1, 5.3, 5.4**

  - [x]* 5.6 Write property test for draw sequence density and monotonicity
    - **Property 11: Draw sequence is dense, monotonic, and matches stored records**
    - Append to `lottery-draw.property.test.mjs`
    - Run `K >= 1` sequential or interleaved draws; assert `GET /lottery/winners` returns exactly `K` items, sorted ascending by `drawSeq`, with `drawSeq` values equal to `[1, 2, ..., K]`, and each item's `{ drawSeq, nickname, tagId, drawnAt }` matches the corresponding `POST /lottery/draw` response body byte-for-byte
    - **Validates: Requirements 5.2, 5.5, 5.7, 5.8**

  - [x]* 5.7 Write property test for authorization rejection
    - **Property 12: Authorization rejection**
    - Append to `lottery-draw.property.test.mjs`
    - For arbitrary claims objects that lack `cognito:groups` or whose `cognito:groups` does not include `admin`, assert `POST /lottery/draw` and `GET /lottery/winners` return 403 (or 401 when claims absent), and the in-memory store has no new `LOTTERY/WINNER#` items
    - **Validates: Requirements 5.6**

- [x] 6. Wire lottery routes into the router
  - [x] 6.1 Add the four lottery routes to `lambda/checkin/src/router.mjs`
    - Match `POST /lottery/nickname` → `handleNicknameRegister(parseBody(event))`
    - Match `GET /lottery/participants` → `handleListParticipants()`
    - Match `POST /lottery/draw` → `handleDraw(extractClaims(event))`
    - Match `GET /lottery/winners` → `handleListWinners(extractClaims(event))`
    - Ensure the new routes are matched before the catch-all 404 and do not interfere with existing routes
    - _Requirements: 3.1, 4.1, 5.1, 5.5_

- [x] 7. Backend checkpoint - All backend lottery logic in place
  - Ensure all backend tests pass, ask the user if questions arise.

- [x] 8. Lottery page scaffolding (`web/lottery/` and `lottery.html`)
  - [x] 8.1 Create `lottery.html` shell and stylesheet
    - Create `lottery.html` at the workspace root (sibling to `signal_hunt.html`) with a full-bleed `<canvas id="lottery-canvas">`, a `<div id="status-indicator">` overlay, a hidden `<div id="error-overlay">`, an `<importmap>` mapping `three` to `https://unpkg.com/three@0.160.0/build/three.module.js`, and `<script type="module" src="web/lottery/main.mjs">`
    - Set `lang="zh-CN"` and `<meta charset="UTF-8">`
    - Inline a minimal dark-background stylesheet using cyan (`#7df9ff`) and purple accents consistent with the Signal Over Noise visual identity
    - Create the `web/lottery/` folder with placeholder `main.mjs` that imports nothing yet
    - _Requirements: 6.1, 7.4, 9.5_

  - [x] 8.2 Implement `truncateNickname` pure helper
    - Create `web/lottery/truncate.mjs` exporting `truncateNickname(s)` that returns `s` when `s.length <= 20` and `s.slice(0, 19) + '…'` otherwise
    - _Requirements: 6.1_

  - [x] 8.3 Implement sphere position generators
    - Create `web/lottery/sphere.mjs` exporting `fibonacciSphere(n)` (Fibonacci-lattice unit-sphere points) and `sphereRadius(n)` returning `Math.max(8, Math.sqrt(n) * 1.5)` for `n >= 10` and `Math.max(4, n * 0.8)` for `n < 10`
    - Document return shapes in JSDoc: `fibonacciSphere(n)` returns `Array<[x, y, z]>` of length `n`
    - _Requirements: 7.1, 7.5_

  - [x]* 8.4 Write property test for nickname truncation rule
    - **Property 13: Nickname truncation rule**
    - Create `web/lottery/__tests__/properties/truncation.property.test.mjs`
    - Use `fc.string()` to generate arbitrary inputs; assert `truncateNickname(s).length <= 20`, `s.length <= 20 ⇒ truncateNickname(s) === s`, and `s.length > 20 ⇒ truncateNickname(s) === s.slice(0, 19) + '…'`
    - **Validates: Requirements 6.1**

  - [x]* 8.5 Write property test for sphere position generator
    - **Property 15: Sphere position generator**
    - Create `web/lottery/__tests__/properties/sphere.property.test.mjs`
    - Generate `n` from `fc.integer({ min: 1, max: 1000 })`; assert `fibonacciSphere(n).length === n` and every point's Euclidean norm is in `[0.99, 1.01]`
    - Assert `sphereRadius` is monotonically non-decreasing on the integer range `[1, 500]`
    - **Validates: Requirements 7.1, 7.5**

- [x] 9. Three.js scene modules
  - [x] 9.1 Implement `Scene` module
    - Create `web/lottery/scene.mjs` exporting a `Scene` class that initializes the Three.js `WebGLRenderer`, perspective camera, ambient + point lights, and a `requestAnimationFrame` render loop bound to `#lottery-canvas`
    - Expose `add(mesh)`, `remove(mesh)`, `update(dt)`, and a `queueReveal(winner)` callback hook (initially a no-op stub to be wired by `WinnerReveal`)
    - Apply a dark background and bloom post-processing on cyan/purple emissive materials
    - _Requirements: 7.4_

  - [x] 9.2 Implement `NoiseEffect` shader module
    - Create `web/lottery/noise-effect.mjs` exporting a factory that returns a `THREE.ShaderMaterial` (or `Points` material) with uniforms `uTime` (float) and `uIntensity` (float in `[0, 1]`)
    - Vertex shader displaces particles by a 3D simplex-noise function scaled by `uIntensity`; fragment shader emits cyan particles with alpha proportional to `uIntensity`
    - Calibrate particle count and displacement so that at `uIntensity = 1.0` the noise visually obscures 40–70% of the wrapped text (Requirement 7.2)
    - _Requirements: 7.2, 7.4_

  - [x] 9.3 Implement `NicknameMesh` module
    - Create `web/lottery/nickname-mesh.mjs` exporting a class wrapping a `THREE.Mesh` (using `TextGeometry` from a loaded `FontLoader` font) with a `THREE.Points` child cloud powered by `NoiseEffect`
    - Apply `truncateNickname` to the displayed text on construction
    - Expose `setIntensity(v)`, `setOpacity(v)`, `setColor(hex)`, `setScale(v)`, and `setPosition(x, y, z)` methods that delegate to the underlying material/mesh
    - Default state: white-cyan emissive material, opacity 1.0, scale 1.0, noise intensity 1.0
    - _Requirements: 6.1, 7.2_

  - [x] 9.4 Implement `LetterFormation` module
    - Create `web/lottery/letter-formation.mjs` exporting a class that, given a list of `NicknameMesh` instances and a target letter (`'A' | 'W' | 'S'`), computes target 3D positions by sampling a 40×60 hidden-canvas bitmap of the glyph rendered with a fat font
    - Tween each mesh's position to its target over a configurable duration (default 2 s) using a simple lerp or `Tween.js`-style interpolator
    - Provide `dispersToOpacityZero()` to fade the previous letter before the next forms (Requirement 6.6)
    - Handle `meshes.length` greater than or fewer than the filled-pixel count using the design's offset and interpolation rules
    - _Requirements: 6.3, 6.4, 6.5, 6.6_

  - [x] 9.5 Implement `SphereFormation` module
    - Create `web/lottery/sphere-formation.mjs` exporting a class that, given a list of `NicknameMesh` instances, computes positions via `fibonacciSphere(N) * sphereRadius(N)` and tweens each mesh to its target over 2–4 s
    - Group all meshes under a parent `THREE.Group` rotating around its Y axis at 10 °/s (within the 5–15 °/s target range)
    - Orient each mesh to `lookAt(camera)` so the text remains legible from the audience
    - _Requirements: 7.1, 7.3, 7.5_

  - [x] 9.6 Implement `WinnerReveal` module
    - Create `web/lottery/winner-reveal.mjs` exporting a class with `revealWinner(mesh, allMeshes)` and `restorePrevious(mesh, allMeshes)`
    - Reveal sequence: tween `uIntensity` from `1.0` → `0.0` over 1.5 s, scale mesh `1.0×` → `3.5×`, lerp color to `#7df9ff`, lift Y position by `sphereRadius(N)`, dim every other mesh's opacity to `0.2`; hold for at least 8 s
    - On the next reveal: set the previous winner's mesh opacity to `0.5`, restore all other meshes to opacity `1.0` and `uIntensity` `1.0`, then run the reveal sequence on the new winner
    - Handle the unknown-winner case (Requirement 8.2): create a new `NicknameMesh` at sphere center, add it to the scene, and run the reveal sequence on it
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x]* 9.7 Write property test for reveal-phase opacity invariants
    - **Property 16: Reveal-phase opacity invariants**
    - Create `web/lottery/__tests__/properties/reveal.property.test.mjs`
    - Drive the reveal animation to its terminal frame in a Node environment using `three`'s pure JS modules (no WebGL renderer required); assert: `W.material.opacity === 1.0`, `W.scale.x >= 3.0`, `W.material.color` is the THREE color of `#7df9ff`, every other mesh's `opacity <= 0.2`
    - For a subsequent reveal of a different winner, at the start of that reveal: previous winner opacity is `0.5`, every other mesh opacity is `1.0`, all meshes' `uIntensity` is `1.0`
    - **Validates: Requirements 8.4, 8.5, 8.7**

- [x] 10. Lottery client and state machine
  - [x] 10.1 Implement `LotteryClient`
    - Create `web/lottery/lottery-client.mjs` exporting a class with `loadParticipants()` (`GET /lottery/participants` with 5 s timeout, fail-fast on `count < 10` or fetch error) and `pollWinners()` (interval 3 s when connected, 5 s when disconnected)
    - Track `knownDrawSeq` (monotonic high-water mark) and `failureStreak`; on each successful poll filter `body.winners.filter(w => w.drawSeq > knownDrawSeq)` and call `scene.queueReveal(w)` for each in ascending `drawSeq` order
    - On 3 consecutive failures (network error, abort timeout, or HTTP `>= 500`), switch to `disconnected`; on the next success, switch back to `connected` and reset `failureStreak` to `0`
    - Expose `lastSuccessAt` for the status indicator
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 10.2 Implement scene state machine in `web/lottery/main.mjs`
    - Wire `Loading → LetterA → LetterW → LetterS → SphereForming → SphereIdle → Revealing → RevealHold` per the design state diagram
    - On `Loading`: call `client.loadParticipants()`; on failure or `count < 10` enter the `Error` state and never transition to letter formations (Requirement 6.2)
    - Each letter holds for 4 s, then transitions to the next; `LetterS` transitions to `SphereForming`
    - `SphereIdle` is the steady state from which `Revealing` is triggered by `scene.queueReveal`
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.3_

  - [x] 10.3 Implement reveal queue with hold gating
    - In `main.mjs`, maintain a FIFO queue of pending winners populated by `scene.queueReveal`
    - Process the next winner only after at least 8000 ms have elapsed since the previous reveal began; while the queue is empty after the hold elapses, return to `SphereIdle`
    - Process queued winners in ascending `drawSeq` order
    - _Requirements: 8.6, 9.2_

  - [x] 10.4 Implement `StatusIndicator`
    - Create `web/lottery/status-indicator.mjs` exporting a class bound to the `#status-indicator` DOM element
    - Expose `update(now, lastSuccessAt)` that sets the element's class to `connected` when `now - lastSuccessAt <= 6000` and `disconnected` otherwise
    - Display the literal text `"已连接"` (connected) or `"未连接"` (disconnected) in Simplified Chinese
    - _Requirements: 9.5_

  - [x]* 10.5 Write property test for letter-formation precondition gate
    - **Property 14: Letter-formation precondition gate**
    - Create `web/lottery/__tests__/properties/letter-precondition.property.test.mjs`
    - Drive the state machine in a JSDOM environment with mocked `fetch`; for any participant list with `count < 10` or any fetch failure, assert the state never reaches `LetterA`, `LetterW`, `LetterS`, `SphereForming`, or `SphereIdle`, and ends in `Error`
    - **Validates: Requirements 6.2**

  - [x]* 10.6 Write property test for reveal hold gating
    - **Property 17: Reveal hold gating**
    - Create `web/lottery/__tests__/properties/reveal-hold.property.test.mjs`
    - Use `vi.useFakeTimers()`; for any sequence of winner detection times `t1 < t2 < ...`, assert that the second reveal's start time is `>= t1 + 8000` ms and that detections within the hold window are queued and processed in ascending `drawSeq` order
    - **Validates: Requirements 8.6, 9.2**

  - [x]* 10.7 Write property test for polling connection state machine
    - **Property 18: Polling connection state machine**
    - Create `web/lottery/__tests__/properties/poll-state.property.test.mjs`
    - Use `fc.array(fc.constantFrom('success', 'failure'))` to generate poll outcome sequences; mock `fetch` deterministically; at each step assert the connection state is `disconnected` iff there exists a window of 3 consecutive failures with no later success, and that the polling interval is 5000 ms while disconnected and 3000 ms while connected
    - Assert `failureStreak` resets to `0` on every successful poll
    - **Validates: Requirements 9.3, 9.4**

  - [x]* 10.8 Write property test for connection-status indicator timing
    - **Property 19: Connection-status indicator timing**
    - Create `web/lottery/__tests__/properties/status-timing.property.test.mjs`
    - For arbitrary `(lastSuccessAt, now)` integer pairs, assert `StatusIndicator.update` sets the element class to `connected` iff `now - lastSuccessAt <= 6000`
    - **Validates: Requirements 9.5**

- [x] 11. Progress page lottery panel integration
  - [x] 11.1 Add lottery panel DOM and conditional renderer to `signal_hunt.html`
    - Insert a `<section id="lottery-panel">` element below the existing progress display
    - Implement `renderLotteryPanel(progress)` that hides the panel when `lotteryEligible` is absent (before time gate, Requirement 10.3); shows a registered-state view with the nickname and `"✓ 已成功登记参与抽奖"` label when `progress.nickname` is present (Requirement 10.2); shows a Simplified-Chinese reason message via `reasonToZh(progress.lotteryReason, progress.stationsRemaining)` when not eligible (Requirement 10.4); and renders the nickname input form when eligible without a nickname (Requirement 10.1)
    - Ensure all text is in Simplified Chinese (Requirement 10.7) and use `escapeHtml` on user-supplied values
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.7_

  - [x] 11.2 Implement nickname submit handler with error mapping
    - Wire the `<form id="nickname-form">` `submit` event to a handler that issues `POST /lottery/nickname { tagId, nickname }`
    - On 200: reload the progress view (or call `renderLotteryPanel` with the new response) so the registered-state view is shown
    - On 409 `nickname_taken`: show inline error `"昵称已被使用，请换一个"`, preserve the input value, allow resubmission (Requirement 10.5)
    - On 409 `already_registered`: show inline error `"您已登记过昵称"`
    - On 400 (`invalid_field` or `missing_field`): show inline error `"昵称格式无效（1-20 个字符，前后不能有空白）"` (Requirement 10.6)
    - On 403 `lottery_not_open`: show `"抽奖尚未开放"`; on 403 `not_eligible`: show eligibility reason in Chinese; on network/5xx: show `"登记失败，请稍后重试"`
    - Validate client-side that input length is 1–20 and trimmed value is non-empty before issuing the request
    - _Requirements: 10.1, 10.5, 10.6, 10.7_

  - [x]* 11.3 Write property test for lottery panel render invariants
    - **Property 20: Lottery panel render invariants**
    - Create `web/lottery/__tests__/properties/panel-render.property.test.mjs` (Vitest with `environment: 'jsdom'`)
    - Generate arbitrary `progress` JSON objects (covering the four cases: `lotteryEligible` absent / `false` / `true with nickname` / `true without nickname`); call `renderLotteryPanel(progress)` and assert the four DOM-shape invariants from the design (panel hidden vs visible, presence/absence of nickname input, nickname text equality, presence of Simplified-Chinese labels)
    - **Validates: Requirements 10.2, 10.3, 10.4, 10.7**

- [x] 12. Frontend checkpoint - Animation, panel, and client wired together
  - Ensure all frontend tests pass, ask the user if questions arise.

- [x] 13. Final integration and end-to-end verification
  - [x] 13.1 Verify CDK deployment exposes the lottery routes and serves `lottery.html`
    - Run `npm --prefix infra run synth` and confirm the synthesized CloudFormation contains the four new HTTP API routes with correct authorizers
    - Confirm the static-asset deployment includes `lottery.html` and the `web/lottery/` directory at the same prefix as `signal_hunt.html`
    - Confirm the Lambda environment includes `AFTER_PARTY_TIME_GATE`
    - Adjust the CDK stack if any of the above are missing
    - _Requirements: 1.3, 4.5, 5.6_

  - [x]* 13.2 Write integration test for end-to-end lottery flow
    - Create `lambda/checkin/__tests__/integration/lottery-flow.integration.test.mjs`
    - Using `aws-sdk-client-mock` with an in-memory store: seed 10 distinct station check-ins (one with `afterParty: true`) for three tags; register a unique nickname for each; call `GET /lottery/participants` and assert `count: 3`; call `POST /lottery/draw` three times and assert each winner is in the registered set; call `GET /lottery/winners` and assert it returns three items with `drawSeq` `[1, 2, 3]` matching the draw responses
    - Cover the negative paths inline: registration before time gate returns 403, registration with duplicate nickname returns 409, draw with no participants returns 400
    - _Requirements: 2.1, 3.1, 4.1, 5.1, 5.5_

- [x] 14. Final checkpoint - All tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Every property test task is annotated with its design property number and the requirements clauses it validates; each test file SHALL include a `// Feature: after-party-lottery, Property {N}: {title}` header comment
- Backend code uses JavaScript ESM (`.mjs`) with Vitest + fast-check + `aws-sdk-client-mock`, matching the existing `nfc-checkin-backend` workspace conventions
- The 3D animation visual quality (frame rate ≥ 30 fps, glow effects, exact tween timing) is intentionally outside the property tests and is validated through a manual browser smoke check on the target display PC, as documented in the design's Testing Strategy
- The lottery handler exports four functions in a single `lottery-handler.mjs` module per the design; tasks that mutate that file are placed in different waves to avoid conflicts during parallel execution
- Checkpoints (tasks 7, 12, 14) are top-level coordination items and are not included in the dependency graph

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "8.1", "8.2", "8.3"] },
    { "id": 1, "tasks": ["1.3", "2.1", "3.1", "4.1", "8.4", "8.5", "9.1", "9.2", "11.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3", "4.2", "4.3", "9.3", "11.2"] },
    { "id": 3, "tasks": ["4.4", "4.5", "4.6", "4.7", "5.1", "9.4", "9.5", "9.6", "10.1", "10.4", "11.3"] },
    { "id": 4, "tasks": ["5.2", "5.4", "9.7", "10.7", "10.8"] },
    { "id": 5, "tasks": ["5.3", "5.5", "10.2", "10.3"] },
    { "id": 6, "tasks": ["5.6", "5.7", "6.1", "10.5", "10.6"] },
    { "id": 7, "tasks": ["13.1", "13.2"] }
  ]
}
```
