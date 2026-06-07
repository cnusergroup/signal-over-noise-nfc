# Requirements Document

## Introduction

The Role-Based Scan System extends the existing Signal Hunt NFC check-in application to support differentiated scan behaviors based on authenticated user roles. Exhibitors scanning a participant's QR code automatically record a check-in at their assigned station. Staff scanning a participant's QR code access a verification panel for one-time lunch and party eligibility checks. Unauthenticated participants continue to see the standard progress page. The system leverages the existing Cognito User Pool, DynamoDB single-table design, and signal_hunt.html popup interface.

## Glossary

- **Signal_Hunt_App**: The signal_hunt.html single-page application that displays the NFC hunt map, progress, and popup modals
- **Cognito_User_Pool**: The existing AWS Cognito User Pool (signal-hunt-admin-pool) used for authentication
- **Exhibitor**: A user assigned to the "exhibitor" Cognito group with a custom:stationId attribute identifying their booth
- **Staff**: A user assigned to the "staff" Cognito group with access to verification endpoints
- **Admin**: A user assigned to the "admin" Cognito group with full administrative access
- **Participant**: An unauthenticated visitor whose NFC tag is scanned at stations
- **Verification_API**: The backend Lambda endpoints (POST /verify/lunch, POST /verify/party) that record one-time verifications
- **Checkin_API**: The existing POST /checkin endpoint that records station visits
- **Scanner_ID**: A value derived from the exhibitor's custom:stationId attribute, used as the scannerId parameter in check-in requests
- **Tag_Record**: A DynamoDB item with PK=TAG#{tagId} and SK=LUNCH or SK=PARTY storing one-time verification status
- **Seed_Script**: A CLI script that creates exhibitor and staff user accounts in the Cognito User Pool

## Requirements

### Requirement 1: Cognito Group Configuration

**User Story:** As a system administrator, I want Cognito groups (admin, exhibitor, staff) added to the existing User Pool, so that users can be assigned role-based permissions.

#### Acceptance Criteria

1. THE Cognito_User_Pool SHALL contain three groups: "admin", "exhibitor", and "staff"
2. WHEN a user authenticates, THE Cognito_User_Pool SHALL include the user's group membership in the ID token claims under the "cognito:groups" attribute
3. THE Cognito_User_Pool SHALL support a custom attribute "custom:stationId" of type String on user accounts

### Requirement 2: Exhibitor Scan Behavior

**User Story:** As an exhibitor, I want to scan a participant's QR code and have it automatically check them in at my station, so that I can efficiently process visitors without manual station selection.

#### Acceptance Criteria

1. WHEN an authenticated Exhibitor scans a participant QR code containing a tagId, THE Signal_Hunt_App SHALL send a POST request to the Checkin_API with the tagId and a scannerId derived from the Exhibitor's custom:stationId attribute
2. WHEN the Checkin_API returns a successful response, THE Signal_Hunt_App SHALL display a confirmation message in the popup showing the participant's tagId and the station name
3. WHEN the Checkin_API returns an error response, THE Signal_Hunt_App SHALL display the error message in the popup
4. WHILE an Exhibitor session is active, THE Signal_Hunt_App SHALL display a simplified scan interface in the popup without the full progress map
5. THE Signal_Hunt_App SHALL derive the scannerId by prepending "station-" to the Exhibitor's custom:stationId value (e.g., custom:stationId "3" produces scannerId "station-3")

### Requirement 3: Staff Scan Behavior

**User Story:** As a staff member, I want to scan a participant's QR code and verify their eligibility for lunch and party rewards, so that I can manage one-time event perks.

#### Acceptance Criteria

1. WHEN an authenticated Staff member scans a participant QR code containing a tagId, THE Signal_Hunt_App SHALL display a verification panel in the popup showing lunch and party verification buttons
2. WHEN a Staff member taps the "Verify Lunch" button, THE Signal_Hunt_App SHALL send a POST request to the Verification_API at /verify/lunch with the tagId in the request body and the Staff member's JWT in the Authorization header
3. WHEN a Staff member taps the "Verify Party" button, THE Signal_Hunt_App SHALL send a POST request to the Verification_API at /verify/party with the tagId in the request body and the Staff member's JWT in the Authorization header
4. WHEN the Verification_API returns a success response, THE Signal_Hunt_App SHALL display a confirmation indicator next to the verified item
5. WHEN the Verification_API returns an "already_verified" error, THE Signal_Hunt_App SHALL display a message indicating the participant has already been verified for that item
6. WHILE a Staff session is active, THE Signal_Hunt_App SHALL display the staff verification interface in the popup instead of the participant progress view

### Requirement 4: Participant Scan Behavior (Unauthenticated)

**User Story:** As a participant, I want to see my progress page when my QR code is scanned without any logged-in user context, so that the existing experience remains unchanged.

#### Acceptance Criteria

1. WHILE no authenticated session exists, THE Signal_Hunt_App SHALL display the standard participant progress page when a tagId is detected in the URL
2. THE Signal_Hunt_App SHALL maintain backward compatibility with the existing progress display, station map, and modal popup behavior for unauthenticated users

### Requirement 5: Lunch Verification Endpoint

**User Story:** As a staff member, I want to verify a participant's lunch eligibility exactly once, so that each participant receives lunch only one time.

#### Acceptance Criteria

1. WHEN a POST request is received at /verify/lunch with a valid JWT from a Staff group member and a tagId in the request body, THE Verification_API SHALL create a Tag_Record with PK=TAG#{tagId} and SK=LUNCH if no such record exists
2. WHEN a POST request is received at /verify/lunch and a Tag_Record with PK=TAG#{tagId} and SK=LUNCH already exists, THE Verification_API SHALL return a 409 response with error code "already_verified"
3. IF a POST request is received at /verify/lunch without a valid JWT, THEN THE Verification_API SHALL return a 401 response
4. IF a POST request is received at /verify/lunch with a valid JWT from a user not in the Staff group, THEN THE Verification_API SHALL return a 403 response
5. IF a POST request is received at /verify/lunch without a tagId in the request body, THEN THE Verification_API SHALL return a 400 response with error code "missing_field" identifying "tagId"

### Requirement 6: Party Verification Endpoint

**User Story:** As a staff member, I want to verify a participant's party eligibility exactly once, so that each participant gains party entry only one time.

#### Acceptance Criteria

1. WHEN a POST request is received at /verify/party with a valid JWT from a Staff group member and a tagId in the request body, THE Verification_API SHALL create a Tag_Record with PK=TAG#{tagId} and SK=PARTY if no such record exists
2. WHEN a POST request is received at /verify/party and a Tag_Record with PK=TAG#{tagId} and SK=PARTY already exists, THE Verification_API SHALL return a 409 response with error code "already_verified"
3. IF a POST request is received at /verify/party without a valid JWT, THEN THE Verification_API SHALL return a 401 response
4. IF a POST request is received at /verify/party with a valid JWT from a user not in the Staff group, THEN THE Verification_API SHALL return a 403 response
5. IF a POST request is received at /verify/party without a tagId in the request body, THEN THE Verification_API SHALL return a 400 response with error code "missing_field" identifying "tagId"

### Requirement 7: Role Detection in Signal Hunt App

**User Story:** As the system, I want signal_hunt.html to detect the authenticated user's role on page load, so that the correct scan interface is displayed.

#### Acceptance Criteria

1. WHEN signal_hunt.html loads, THE Signal_Hunt_App SHALL check for an existing Cognito session using the cognito-identity-js library
2. WHEN a valid session is found, THE Signal_Hunt_App SHALL extract the "cognito:groups" claim from the ID token to determine the user's role
3. WHEN the user belongs to the "exhibitor" group, THE Signal_Hunt_App SHALL render the exhibitor scan interface in the popup
4. WHEN the user belongs to the "staff" group, THE Signal_Hunt_App SHALL render the staff verification interface in the popup
5. WHEN no valid session is found, THE Signal_Hunt_App SHALL render the standard participant progress interface

### Requirement 8: Session Persistence

**User Story:** As an exhibitor or staff member, I want my session to persist across page reloads, so that I do not need to re-authenticate for each scan.

#### Acceptance Criteria

1. THE Signal_Hunt_App SHALL store Cognito session tokens in localStorage
2. WHEN the page reloads, THE Signal_Hunt_App SHALL attempt to restore the session from localStorage before rendering the interface
3. WHEN a stored session token has expired, THE Signal_Hunt_App SHALL attempt to refresh the session using the refresh token
4. IF the refresh token is also expired, THEN THE Signal_Hunt_App SHALL clear the stored session and render the participant interface

### Requirement 9: Account Seed Script

**User Story:** As a system administrator, I want a CLI script to create exhibitor and staff accounts in Cognito, so that I can provision accounts before the event.

#### Acceptance Criteria

1. THE Seed_Script SHALL accept a JSON configuration file specifying user accounts with email, group assignment, and optional custom:stationId
2. WHEN executed, THE Seed_Script SHALL create each user in the Cognito_User_Pool with the specified email and attributes
3. WHEN executed, THE Seed_Script SHALL assign each user to the specified Cognito group
4. WHEN a user already exists in the pool, THE Seed_Script SHALL skip that user and log a warning message
5. THE Seed_Script SHALL output a summary of created users, skipped users, and any errors

### Requirement 10: Backward Compatibility

**User Story:** As a system administrator, I want the existing admin.html and redeem.html pages to continue functioning without modification, so that current admin workflows are not disrupted.

#### Acceptance Criteria

1. THE Signal_Hunt_App changes SHALL NOT modify the behavior of admin.html or redeem.html
2. THE existing JWT authorizer on admin routes (missions, combos, rewards/redeem) SHALL continue to function with the existing admin user credentials
3. THE new /verify/lunch and /verify/party routes SHALL NOT conflict with any existing API routes
