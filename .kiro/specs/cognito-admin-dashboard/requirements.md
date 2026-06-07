# Requirements Document

## Introduction

This feature replaces the existing API key-based authentication on admin routes with Amazon Cognito JWT-based authentication, and provides a single-page admin dashboard (admin.html) for managing the Signal Hunt event. The dashboard includes an embedded login form using the amazon-cognito-identity-js SDK from CDN, and exposes management UIs for missions, combos, winners, leaderboard, and station traffic. The visual design matches the existing dark sci-fi aesthetic of the check-in page.

## Glossary

- **Admin_Dashboard**: The single-page HTML file (admin.html) served via S3/CloudFront that provides the admin management interface
- **Cognito_User_Pool**: The Amazon Cognito User Pool resource provisioned in the CDK stack for admin authentication
- **JWT_Authorizer**: The API Gateway HTTP API JWT authorizer that validates Cognito-issued tokens on admin routes
- **Login_Form**: The embedded authentication form within admin.html that collects email and password credentials
- **CDK_Stack**: The AWS CDK TypeScript stack defined in infra/lib/signal-hunt-stack.ts
- **Admin_User**: The pre-created Cognito user whose email is supplied at deploy time via CDK context (`adminEmail`) or the `ADMIN_EMAIL` environment variable
- **HTTP_API**: The existing API Gateway HTTP API (signal-hunt-api) in region ap-northeast-1
- **Check-in_Lambda**: The existing Lambda function that handles all API routes

## Requirements

### Requirement 1: Cognito User Pool Provisioning

**User Story:** As a platform operator, I want a Cognito User Pool provisioned in the CDK stack, so that admin authentication is managed by a dedicated identity service.

#### Acceptance Criteria

1. THE CDK_Stack SHALL provision a Cognito_User_Pool with email as the sole sign-in attribute.
2. THE CDK_Stack SHALL configure the Cognito_User_Pool with a user pool client that supports the USER_PASSWORD_AUTH authentication flow.
3. THE CDK_Stack SHALL configure the Cognito_User_Pool user pool client without a client secret.
4. THE CDK_Stack SHALL output the User Pool ID and User Pool Client ID as CloudFormation stack outputs.
5. WHEN the CDK_Stack is deployed, THE CDK_Stack SHALL create the Admin_User with the configured admin email in the Cognito_User_Pool with a verified email status.

### Requirement 2: JWT Authorizer Migration

**User Story:** As a platform operator, I want admin routes protected by a Cognito JWT authorizer instead of the Lambda-based API key authorizer, so that authentication is handled at the API Gateway layer with industry-standard tokens.

#### Acceptance Criteria

1. THE CDK_Stack SHALL replace the existing HttpLambdaAuthorizer with a JWT_Authorizer configured to validate tokens issued by the Cognito_User_Pool.
2. THE JWT_Authorizer SHALL validate the audience claim against the Cognito User Pool Client ID.
3. THE JWT_Authorizer SHALL use the Authorization header as the identity source.
4. WHEN a request to an admin route includes a valid JWT token, THE HTTP_API SHALL forward the request to the Check-in_Lambda.
5. WHEN a request to an admin route includes an expired or invalid JWT token, THE HTTP_API SHALL return a 401 response without invoking the Check-in_Lambda.
6. WHEN a request to an admin route includes no Authorization header, THE HTTP_API SHALL return a 401 response without invoking the Check-in_Lambda.
7. THE CDK_Stack SHALL remove the API_KEY environment variable from the Check-in_Lambda configuration.
8. THE Check-in_Lambda router SHALL remove the validateApiKey call and the isAdminRoute authentication check from its request processing logic.

### Requirement 3: Admin Login Interface

**User Story:** As an admin, I want an embedded login form on the admin page, so that I can authenticate with my Cognito credentials without being redirected to a hosted UI.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL include the amazon-cognito-identity-js library loaded from a CDN.
2. THE Login_Form SHALL collect an email address field and a password field.
3. WHEN the admin submits valid credentials, THE Login_Form SHALL authenticate against the Cognito_User_Pool and store the JWT tokens in browser memory.
4. WHEN the admin submits invalid credentials, THE Login_Form SHALL display an error message describing the authentication failure.
5. WHEN a NEW_PASSWORD_REQUIRED challenge is returned, THE Login_Form SHALL display a new password input and allow the admin to set a permanent password.
6. WHILE the admin is authenticated, THE Admin_Dashboard SHALL include the JWT ID token in the Authorization header of all API requests to admin routes.
7. WHEN the JWT token expires, THE Admin_Dashboard SHALL attempt to refresh the token using the refresh token before prompting re-authentication.
8. THE Admin_Dashboard SHALL provide a logout action that clears stored tokens and returns to the Login_Form.

### Requirement 4: Dashboard Overview

**User Story:** As an admin, I want a dashboard overview showing event statistics at a glance, so that I can monitor event health without navigating to individual sections.

#### Acceptance Criteria

1. WHILE the admin is authenticated, THE Admin_Dashboard SHALL display a statistics panel showing total check-ins, unique visitors, active missions count, and stamp rally completions.
2. THE Admin_Dashboard SHALL fetch statistics data from the existing public API endpoints (GET /stations, GET /leaderboard).
3. THE Admin_Dashboard SHALL display a loading indicator while statistics data is being fetched.
4. IF a statistics API request fails, THEN THE Admin_Dashboard SHALL display an error message with a retry option.

### Requirement 5: Mission Management UI

**User Story:** As an admin, I want a UI to create, view, edit, and delete missions of all four types, so that I can manage event gamification without using API tools.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL display a missions list showing each mission's name, type, station, status, start time, and end time.
2. THE Admin_Dashboard SHALL provide a create mission form with fields for type (numbered_visit, lucky_draw, early_bird, last_call), name, station ID, start time, end time, and type-specific fields (milestones, winner count, prize description, bonus points).
3. WHEN the admin selects a mission type, THE Admin_Dashboard SHALL display only the fields relevant to that mission type.
4. WHEN the admin submits a valid create mission form, THE Admin_Dashboard SHALL send a POST request to /missions with the JWT token and display the created mission in the list.
5. THE Admin_Dashboard SHALL provide an edit form pre-populated with the existing mission data for missions with status "scheduled".
6. WHEN the admin submits a valid edit form, THE Admin_Dashboard SHALL send a PUT request to /missions/{missionId} with the JWT token and update the mission in the list.
7. THE Admin_Dashboard SHALL provide a delete action for missions with status "scheduled".
8. WHEN the admin confirms a delete action, THE Admin_Dashboard SHALL send a DELETE request to /missions/{missionId} with the JWT token and remove the mission from the list.
9. THE Admin_Dashboard SHALL disable edit and delete actions for missions with status "active" or "completed".

### Requirement 6: Combo Management UI

**User Story:** As an admin, I want a UI to create and view combo bonuses, so that I can configure station combinations for attendee rewards.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL display a combos list showing each combo's name, required stations, and reward description.
2. THE Admin_Dashboard SHALL provide a create combo form with fields for name, station selection (multi-select from stations 1-10), and reward description.
3. WHEN the admin submits a valid create combo form, THE Admin_Dashboard SHALL send a POST request to /combos with the JWT token and display the created combo in the list.
4. THE Admin_Dashboard SHALL fetch the existing combos from GET /combos on page load.

### Requirement 7: Winners Viewer

**User Story:** As an admin, I want to view mission winners, so that I can verify prize distribution and announce results.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL provide a winners view accessible from each mission in the missions list.
2. WHEN the admin requests winners for a mission, THE Admin_Dashboard SHALL fetch data from GET /missions/{missionId}/winners and display the winner list.
3. THE Admin_Dashboard SHALL display each winner's tag ID and award timestamp.
4. IF a mission has no winners, THEN THE Admin_Dashboard SHALL display a message indicating no winners have been selected.

### Requirement 8: Leaderboard Viewer

**User Story:** As an admin, I want to view the speed challenge leaderboard, so that I can monitor competition standings.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL display the leaderboard data fetched from GET /leaderboard.
2. THE Admin_Dashboard SHALL display each entry's rank, masked tag ID, elapsed time formatted as minutes and seconds, and completion timestamp.
3. THE Admin_Dashboard SHALL provide a refresh action to reload leaderboard data.

### Requirement 9: Station Traffic Viewer

**User Story:** As an admin, I want to view station traffic data, so that I can monitor booth activity and identify bottlenecks.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL display a station traffic summary showing unique visitor counts for all 10 stations.
2. WHEN the admin selects a station, THE Admin_Dashboard SHALL fetch detailed traffic data from GET /stations/{stationId} and display recent check-in timestamps.
3. THE Admin_Dashboard SHALL provide a refresh action to reload station traffic data.

### Requirement 10: Visual Design

**User Story:** As an admin, I want the admin dashboard to match the dark sci-fi aesthetic of the check-in page, so that the experience is visually cohesive.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL use the same CSS custom properties as the check-in page (--bg: #050914, --panel, --line, --signal, --signal-2 through --signal-10, --text, --muted, --overlay).
2. THE Admin_Dashboard SHALL use the Share Tech Mono font for monospace elements and Inter for body text.
3. THE Admin_Dashboard SHALL use glassmorphism panels with backdrop-filter blur, semi-transparent backgrounds, and cyan/purple glow effects consistent with the check-in page.
4. THE Admin_Dashboard SHALL implement the single-page HTML pattern with inline CSS and inline JavaScript.
5. THE Admin_Dashboard SHALL be responsive and usable on viewport widths from 375px to 1440px.

### Requirement 11: Legacy Auth Removal

**User Story:** As a platform operator, I want the old API key authentication mechanism fully removed, so that there is a single authentication path and no dead code.

#### Acceptance Criteria

1. THE CDK_Stack SHALL remove the HttpLambdaAuthorizer construct and its associated import.
2. THE Check-in_Lambda SHALL remove the validateApiKey function from the validator module.
3. THE Check-in_Lambda router SHALL remove the isAdminRoute function and the API key validation logic.
4. THE CDK_Stack SHALL remove the API_KEY environment variable from the Check-in_Lambda function.
5. THE workspace SHALL delete the .api-key.txt file.
6. WHEN the CORS configuration is updated, THE HTTP_API SHALL include "Authorization" in the allowed headers list.
