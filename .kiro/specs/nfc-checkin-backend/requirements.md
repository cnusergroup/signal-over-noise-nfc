# Requirements Document

## Introduction

This document specifies the requirements for the NFC Check-in Backend system for the "Signal Over Noise" community day event. The system enables attendees to check in at exhibitor booths by tapping NFC-enabled badges, records visit data, and provides gamification features (missions, lucky draws, and other traffic-driving interactions) to incentivize booth visits and increase exhibitor engagement.

## Glossary

- **Check_In_Service**: The backend system that processes NFC check-in requests and manages check-in records
- **NFC_Tag**: A unique identifier embedded in an attendee's badge/card, used to identify the attendee
- **NFC_Tag_Registry**: A pre-loaded DynamoDB table containing all valid NFC_Tag identifiers, provisioned before the event begins
- **Scanner**: An NFC reader device at an exhibitor booth that reads NFC tags and sends check-in requests
- **Station**: An exhibitor booth location (numbered 1–10) where attendees can check in
- **Mission_Engine**: The subsystem that manages time-limited missions and their rules
- **Mission**: A time-bounded interactive challenge associated with one or more stations that rewards visitors
- **Lucky_Draw**: A mission type where N random visitors within a time window receive prizes
- **Numbered_Visit_Mission**: A mission type where visitors are sequentially numbered during a time window (1st, 2nd, 3rd visitor, etc.)
- **Stamp_Rally**: A gamification feature where attendees collect check-ins across multiple stations to earn rewards
- **Combo_Bonus**: A reward triggered when an attendee visits a specific combination of stations
- **Leaderboard**: A ranked display of attendees based on check-in count or speed
- **Cooldown_Period**: A minimum time interval between consecutive check-ins by the same NFC tag at the same station
- **Early_Bird**: A mission type that rewards the first N visitors to a station after a specified start time
- **Last_Call**: A mission type that rewards the last N visitors to a station before a specified end time

## Requirements

### Requirement 1: NFC Check-in Recording

**User Story:** As an event organizer, I want to record each attendee's booth visit via NFC tap, so that I can track booth traffic and attendee engagement.

#### Acceptance Criteria

1. WHEN a Scanner sends a POST request containing an NFC_Tag identifier and a Scanner identifier, THE Check_In_Service SHALL create a check-in record with the NFC_Tag identifier, the Station identifier mapped from the Scanner identifier, and an ISO 8601 UTC timestamp
2. WHEN a check-in record is created, THE Check_In_Service SHALL return a success response containing the NFC_Tag identifier, Station identifier, and check-in timestamp within 500ms measured from request receipt to response dispatch under a peak concurrency of 50 simultaneous requests
3. IF the POST request is missing the NFC_Tag identifier or the Scanner identifier, THEN THE Check_In_Service SHALL return a 400 error response with a message indicating which required field is missing
4. IF the NFC_Tag identifier does not match a registered tag in the NFC_Tag registry (a pre-loaded DynamoDB table of valid tag identifiers provisioned before the event), THEN THE Check_In_Service SHALL return a 404 error response indicating the tag is unrecognized
5. WHILE a Cooldown_Period of 30 seconds has not elapsed since the last successful check-in by the same NFC_Tag at the same Station, THE Check_In_Service SHALL reject the duplicate check-in with a 429 response indicating the remaining cooldown time in seconds; however, mission-related processing (e.g., returning a previously assigned visitor number) SHALL still be evaluated and included in the 429 response body
6. IF the Scanner identifier does not map to a valid Station identifier within the range of 1 to 10, THEN THE Check_In_Service SHALL return a 400 error response indicating the scanner is unrecognized
7. IF the Check_In_Service encounters an internal failure while persisting the check-in record, THEN THE Check_In_Service SHALL return a 500 error response and SHALL NOT create a partial check-in record
8. THE Check_In_Service check-in and query endpoints (Requirements 1–3) SHALL NOT require authentication, as they are accessed by NFC scanners and attendee-facing kiosks that do not hold credentials

### Requirement 2: Check-in Progress Query

**User Story:** As an attendee, I want to view my check-in progress across all stations, so that I can see which booths I have visited and which remain.

#### Acceptance Criteria

1. WHEN a GET request is received with an NFC_Tag identifier, THE Check_In_Service SHALL return a list of all check-in records for that tag, including Station identifiers and timestamps, sorted by Station identifier in ascending order
2. WHEN a GET request is received with an NFC_Tag identifier, THE Check_In_Service SHALL return the total number of unique stations visited and a boolean indicating whether all 10 stations are complete
3. IF the NFC_Tag identifier has no check-in records, THEN THE Check_In_Service SHALL return an empty station list with a total count of zero and a completion status of false
4. IF the NFC_Tag identifier is missing or is an empty string, THEN THE Check_In_Service SHALL return an error response indicating that a valid NFC_Tag identifier is required
5. WHEN a GET request is received with a valid NFC_Tag identifier, THE Check_In_Service SHALL return the progress response within 3 seconds

### Requirement 3: Station Traffic Query

**User Story:** As an event organizer, I want to query check-in traffic per station, so that I can monitor booth popularity in real time.

#### Acceptance Criteria

1. WHEN a GET request is received with a valid Station identifier (integer 1–10), THE Check_In_Service SHALL return the total number of unique visitors and a list of up to 1000 check-in timestamps for that station, sorted in descending chronological order
2. WHEN a GET request is received without a Station identifier, THE Check_In_Service SHALL return a summary containing each station's identifier and its corresponding unique visitor count for all stations (1–10)
3. IF a GET request is received with a Station identifier that is not an integer between 1 and 10, THEN THE Check_In_Service SHALL return an error response indicating the station identifier is invalid and SHALL NOT query the data store
4. THE Check_In_Service SHALL return station traffic query responses within 3 seconds under normal operating conditions

### Requirement 4: Numbered Visit Mission

**User Story:** As an exhibitor, I want to run a limited-time mission where visitors are numbered sequentially, so that I can reward milestone visitors (e.g., the 10th, 50th, 100th visitor).

#### Acceptance Criteria

1. WHEN an administrator creates a Numbered_Visit_Mission, THE Mission_Engine SHALL store the mission with a start time, end time, target Station identifier, and a list of 1 to 100 milestone numbers defined as positive integers
2. WHILE a Numbered_Visit_Mission is active (current time is between start time inclusive and end time inclusive) for a Station, THE Mission_Engine SHALL assign a sequential visitor number starting at 1 to each unique NFC_Tag that checks in at that Station during the mission window, and include the assigned visitor number in the check-in response
3. IF an NFC_Tag that has already been assigned a visitor number for a Numbered_Visit_Mission checks in again at the same Station during that mission (including check-ins rejected by cooldown), THEN THE Mission_Engine SHALL return the previously assigned visitor number without incrementing the sequence counter
4. WHEN a check-in results in a visitor number that matches a milestone number, THE Mission_Engine SHALL include a milestone notification in the check-in response containing the milestone number reached and the visitor's assigned sequence number
5. IF a Numbered_Visit_Mission has ended and an NFC_Tag checks in at the target Station, THEN THE Mission_Engine SHALL not assign a visitor number for that mission and SHALL return an indication that the mission has ended along with the final visitor count
6. THE Mission_Engine SHALL guarantee that no two distinct NFC_Tags receive the same sequence number for the same mission under concurrent check-in conditions, using an atomic counter (DynamoDB atomic increment)
7. IF multiple Numbered_Visit_Missions are active simultaneously for the same Station, THE Mission_Engine SHALL maintain independent sequence counters for each mission and include all applicable visitor numbers in the check-in response

### Requirement 5: Lucky Draw Mission

**User Story:** As an exhibitor, I want to run a lucky draw during a time window so that random visitors to my booth win prizes, driving more traffic.

#### Acceptance Criteria

1. WHEN an administrator creates a Lucky_Draw mission, THE Mission_Engine SHALL store the mission with a start time, end time, target Station identifier, number of winners (N) where N is between 1 and 100 inclusive, and a prize description of at most 500 characters
2. IF an administrator attempts to create a Lucky_Draw mission with N less than 1, N greater than 100, a start time equal to or after the end time, or a prize description exceeding 500 characters, THEN THE Mission_Engine SHALL reject the request and return an error message indicating the invalid field
3. WHILE a Lucky_Draw mission is active (current time is between start time and end time inclusive), THE Mission_Engine SHALL record each check-in at the target Station as an eligible entry, limited to one entry per visitor per mission
4. WHEN the current time reaches the end time of a Lucky_Draw mission, a scheduled EventBridge rule SHALL trigger a Lambda function that performs the winner selection by randomly choosing N winners from all eligible entries using a cryptographically secure random algorithm
5. WHEN a Lucky_Draw mission ends, THE Mission_Engine SHALL store the winner list as immutable and make it queryable by mission identifier within 5 seconds of the selection completing
6. IF fewer than N eligible entries exist when the mission ends, THEN THE Mission_Engine SHALL select all eligible entries as winners and record the actual winner count
7. WHEN a Lucky_Draw winner list is queryable, THE Mission_Engine SHALL expose a GET endpoint at /missions/{missionId}/winners that returns the list of winning NFC_Tag identifiers and the prize description

### Requirement 6: Stamp Rally Completion Reward

**User Story:** As an event organizer, I want to reward attendees who visit all 10 stations, so that attendees are motivated to explore every booth.

#### Acceptance Criteria

1. WHEN an attendee's check-in results in all 10 stations being visited, THE Check_In_Service SHALL mark the attendee as having completed the Stamp_Rally and include a completion status and a reward code in the check-in response
2. WHEN a completed Stamp_Rally attendee's progress is queried, THE Check_In_Service SHALL return the same reward code that was generated at completion time
3. THE Check_In_Service SHALL generate a reward code that is at least 16 characters long, unique per attendee, and produced using a cryptographically secure random generator
4. IF an attendee who has already completed the Stamp_Rally checks in to a station again, THEN THE Check_In_Service SHALL return the existing completion status and reward code without generating a new reward code

### Requirement 7: Combo Bonus

**User Story:** As an event organizer, I want to define station combinations that trigger bonus rewards, so that I can drive traffic to specific groups of booths.

#### Acceptance Criteria

1. WHEN an authenticated administrator sends a POST request to create a Combo_Bonus, THE Mission_Engine SHALL store the combo with a unique name (maximum 100 characters), the required set of Station identifiers (minimum 2, maximum 10 stations, no duplicates), and the associated reward description (maximum 200 characters)
2. IF an administrator attempts to define a Combo_Bonus containing a Station identifier that is not an integer between 1 and 10, or containing duplicate Station identifiers, THEN THE Mission_Engine SHALL reject the request with an error message indicating the invalid field
3. WHEN a check-in completes a Combo_Bonus set for an attendee, THE Mission_Engine SHALL include in the check-in response the Combo_Bonus name, the reward description, and the list of Station identifiers that formed the combo
4. THE Mission_Engine SHALL award each Combo_Bonus to an attendee at most once
5. IF a Combo_Bonus set contains all 10 stations, THE Mission_Engine SHALL award both the Combo_Bonus and the Stamp_Rally reward independently (double-rewarding is permitted)
6. WHEN an authenticated administrator sends a GET request to /combos, THE Mission_Engine SHALL return a list of all defined Combo_Bonus configurations

### Requirement 8: Speed Challenge Leaderboard

**User Story:** As an event organizer, I want a leaderboard showing who completed all stations fastest, so that attendees are motivated to visit booths quickly.

#### Acceptance Criteria

1. WHEN an attendee completes all 10 stations, THE Check_In_Service SHALL calculate the elapsed time in whole seconds between the earliest and latest check-in timestamps recorded for that attendee
2. WHEN a GET request is received for the Leaderboard, THE Check_In_Service SHALL return up to 20 completions sorted by elapsed time in ascending order, where ties are broken by earlier completion timestamp first, each entry containing a masked NFC_Tag identifier (first 4 and last 4 characters visible, middle replaced with asterisks) and elapsed time in whole seconds
3. THE Check_In_Service SHALL update the Leaderboard within 5 seconds of a new completion
4. IF a GET request is received for the Leaderboard and no attendee has completed all 10 stations, THEN THE Check_In_Service SHALL return an empty list with zero total entries
5. THE Leaderboard size of 20 entries SHALL be a fixed system constant for this event

### Requirement 9: Early Bird / Last Call Bonus

**User Story:** As an event organizer, I want to reward the first N check-ins at a station after it opens and the last N check-ins before it closes, so that I can drive traffic during off-peak hours and sustain engagement throughout the day.

#### Acceptance Criteria

1. WHEN an administrator creates an Early_Bird mission, THE Mission_Engine SHALL store the mission with a target Station identifier, a start time, a winner count (N) where N is an integer between 1 and 100 inclusive, and a bonus point value (positive integer)
2. WHILE an Early_Bird mission is active (from start time until N unique winners are recorded or the event ends, whichever comes first), THE Mission_Engine SHALL award the configured bonus point value to the first N unique NFC_Tags that check in at the target Station after the mission start time, and SHALL transition the mission to a completed state once N unique winners have been recorded
3. WHEN an administrator creates a Last_Call mission, THE Mission_Engine SHALL store the mission with a target Station identifier, an end time, a winner count (N) where N is an integer between 1 and 100 inclusive, and a bonus point value (positive integer)
4. WHEN a Last_Call mission ends, THE Mission_Engine SHALL determine the last N unique NFC_Tags that checked in at the target Station before the mission end time by maintaining a sliding window of the most recent N unique visitors, and SHALL award the configured bonus point value to those visitors
5. WHEN a check-in triggers an Early_Bird bonus, THE Mission_Engine SHALL include the bonus point value and the attendee's position (e.g., "You are early bird #3!") in the check-in response
6. WHEN a Last_Call mission ends, THE Mission_Engine SHALL make the winner list queryable via a GET endpoint at /missions/{missionId}/winners within 5 seconds of the mission end time
7. IF fewer than N unique NFC_Tags check in during an Early_Bird or Last_Call mission window, THEN THE Mission_Engine SHALL award the bonus only to those NFC_Tags that did check in and mark the mission as completed with the actual winner count
8. IF an NFC_Tag that has already been awarded an Early_Bird bonus at a Station checks in again at the same Station during the same mission, THEN THE Mission_Engine SHALL process the check-in normally without awarding a duplicate bonus and without counting it toward the N winner slots

### Requirement 10: Mission Administration API

**User Story:** As an event organizer, I want to create, update, query, and list missions via an API, so that I can manage gamification features during the event.

#### Acceptance Criteria

1. WHEN an authenticated administrator sends a POST request with mission parameters (including at minimum: mission type, mission name, start time, and end time), THE Mission_Engine SHALL create a new mission and return the mission identifier within 2 seconds
2. WHEN an authenticated administrator sends a GET request with a mission identifier, THE Mission_Engine SHALL return the mission configuration and current status within 2 seconds
3. WHEN an authenticated administrator sends a GET request to /missions without a mission identifier, THE Mission_Engine SHALL return a list of all missions with their identifiers, names, types, and statuses
4. WHEN an authenticated administrator sends a PUT request to update a mission that has not yet started (current time is before the mission start time), THE Mission_Engine SHALL apply the provided field changes to the specified mission and return the complete updated mission representation
5. IF a PUT request targets a mission that is currently active or has ended, THEN THE Mission_Engine SHALL reject the update with a 409 error indicating that active or completed missions cannot be modified
6. WHEN an authenticated administrator sends a DELETE request with a mission identifier for a mission that has not yet started, THE Mission_Engine SHALL remove the mission and return a 204 response
7. IF a DELETE request targets a mission that is currently active or has ended, THEN THE Mission_Engine SHALL reject the deletion with a 409 error indicating that active or completed missions cannot be deleted
8. IF a mission creation or update request contains invalid parameters (missing required fields, end time before start time, or name exceeding 200 characters), THEN THE Mission_Engine SHALL reject the request with a 400 error and an error message indicating which parameter failed validation
9. IF a request includes an invalid or missing API key in the Authorization header, THEN THE Mission_Engine SHALL reject the request with a 401 error and an error message indicating authentication failure
10. IF a GET, PUT, or DELETE request references a mission identifier that does not exist, THEN THE Mission_Engine SHALL return a 404 error with an error message indicating the mission was not found

### Requirement 11: Data Expiration

**User Story:** As an event organizer, I want check-in data to automatically expire after the event, so that storage costs remain minimal.

#### Acceptance Criteria

1. WHEN a check-in record is created, THE Check_In_Service SHALL set a time-to-live attribute with a value equal to the creation timestamp plus 30 days, expressed as a Unix epoch in seconds
2. WHEN a mission record is created, THE Mission_Engine SHALL set a time-to-live attribute with a value equal to the mission end time plus 30 days, expressed as a Unix epoch in seconds
3. THE Check_In_Service SHALL rely on DynamoDB TTL to automatically delete expired records, accepting that deletion may occur up to 48 hours after the TTL timestamp is reached
4. WHILE a record's TTL timestamp has passed but the record has not yet been deleted by DynamoDB, THE Check_In_Service SHALL exclude that record from query results by filtering out items whose TTL value is less than the current time
5. THE SLA targets (500ms for check-in, 3s for queries) SHALL be validated against an expected data volume of up to 500 registered NFC_Tags and up to 5000 check-in records per station per event day
