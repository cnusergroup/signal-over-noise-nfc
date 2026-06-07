# Requirements Document

## Introduction

This document specifies the requirements for the After Party Lottery feature of the "Signal Over Noise" NFC check-in system. The feature provides a lottery draw mechanism for attendees who complete all 10 station check-ins and participate in the After Party event. The lottery includes a time-gated After Party check-in, a unique nickname registration system, and a 3D animated lottery draw page displayed on a big screen during the After Party event. The visual theme follows the "Signal Over Noise" concept where participants are wrapped in noise and the winner is revealed as a clear signal.

## Glossary

- **Lottery_Service**: The backend subsystem that manages After Party lottery eligibility, nickname registration, and winner selection
- **Time_Gate**: The threshold of June 28, 2026, 17:00 CST (UTC+8), equivalent to June 28, 2026, 09:00 UTC, after which all check-ins qualify as After Party check-ins
- **After_Party_Checkin**: Any check-in recorded at any station after the Time_Gate has passed
- **Lottery_Participant**: An attendee who has completed all 10 station check-ins AND has at least one After_Party_Checkin AND has registered a unique nickname
- **Nickname**: A unique display name registered by an eligible attendee for use in the lottery draw display
- **Lottery_Page**: A standalone HTML page (lottery.html) that displays the 3D animated lottery draw for projection on a big screen
- **Noise_Effect**: A visual particle/distortion effect wrapping each participant's nickname in the 3D animation, representing unresolved signal
- **Signal_Reveal**: The visual effect when a winner is selected — the Noise_Effect dissolves to reveal the winner's nickname clearly highlighted
- **Progress_Page**: The existing signal_hunt.html page that shows a participant's check-in progress

## Requirements

### Requirement 1: Time Gate Determination

**User Story:** As the system, I want to identify check-ins that occur after 17:00 CST on June 28, 2026, so that they count as After Party participation.

#### Acceptance Criteria

1. WHEN a successful check-in is recorded with a timestamp equal to or later than the configured AFTER_PARTY_TIME_GATE value (default: 2026-06-28T09:00:00Z, representing June 28, 2026, 17:00 CST), THE Lottery_Service SHALL persist an afterParty attribute of true on that check-in record, classifying it as an After_Party_Checkin
2. WHEN a successful check-in is recorded with a timestamp earlier than the configured AFTER_PARTY_TIME_GATE value, THE Lottery_Service SHALL persist an afterParty attribute of false on that check-in record, indicating it is not an After_Party_Checkin
3. THE Lottery_Service SHALL read the Time_Gate value from a configurable environment variable (AFTER_PARTY_TIME_GATE) in ISO 8601 UTC format, defaulting to 2026-06-28T09:00:00Z
4. IF the AFTER_PARTY_TIME_GATE environment variable is present but not a valid ISO 8601 UTC timestamp, THEN THE Lottery_Service SHALL fail to start and log an error message indicating the malformed time gate value
5. WHEN a GET request is received for check-in progress for a tag, THE Lottery_Service SHALL include a boolean field (afterPartyEligible) in the response, set to true if the tag has at least one check-in record where the afterParty attribute is true, and false otherwise
6. WHEN determining After_Party_Checkin classification, THE Lottery_Service SHALL only consider check-ins that were successfully persisted (not rejected by cooldown or validation errors)

### Requirement 2: Lottery Eligibility Verification

**User Story:** As an attendee, I want the system to verify that I have completed all 10 stations and participated in the After Party, so that I know whether I qualify for the lottery.

#### Acceptance Criteria

1. WHEN a participant's progress is queried at or after the Time_Gate, THE Lottery_Service SHALL return a lotteryEligible boolean that is true only when both conditions are met: all 10 station check-ins are completed AND at least one After_Party_Checkin exists for that tag, and SHALL return the response within 3 seconds
2. IF a participant has completed all 10 stations but has no After_Party_Checkin, THEN THE Lottery_Service SHALL return lotteryEligible as false with a reason field containing a machine-readable string indicating After Party check-in is required
3. IF a participant has an After_Party_Checkin but has not completed all 10 stations, THEN THE Lottery_Service SHALL return lotteryEligible as false with a reason field containing a machine-readable string indicating incomplete station visits and a count of the stations still missing
4. THE Lottery_Service SHALL determine eligibility by checking existing check-in records, requiring no additional user action beyond the normal NFC check-in process after the Time_Gate
5. WHILE the current time is before the Time_Gate, THE Lottery_Service SHALL omit the lotteryEligible field from the progress response or return it as false, and SHALL NOT return any lottery-related reason field

### Requirement 3: Nickname Registration

**User Story:** As a lottery-eligible attendee, I want to register a unique nickname for the lottery draw, so that my name appears on the big screen during the lottery animation.

#### Acceptance Criteria

1. WHEN a lottery-eligible participant sends a POST request with a tagId and a nickname (1 to 20 characters, no leading or trailing whitespace, containing only printable Unicode characters excluding control characters), THE Lottery_Service SHALL store the nickname associated with that tag and return a success response within 2 seconds
2. THE Lottery_Service SHALL enforce nickname uniqueness using case-sensitive comparison across all participants using a DynamoDB conditional write that fails if the nickname already exists as a separate uniqueness record
3. IF a participant submits a nickname that is already registered by another participant, THEN THE Lottery_Service SHALL return a 409 error response indicating the nickname is already taken
4. IF a participant submits a nickname that is empty, exceeds 20 characters, or contains only whitespace, THEN THE Lottery_Service SHALL return a 400 error response indicating the nickname format is invalid
5. IF a participant who is not lottery-eligible (missing station completions or missing After_Party_Checkin) attempts to register a nickname, THEN THE Lottery_Service SHALL return a 403 error response indicating the participant does not meet lottery eligibility requirements
6. IF the current time is before the Time_Gate, THEN THE Lottery_Service SHALL return a 403 error response indicating that nickname registration is not yet available
7. IF a participant who has already registered a nickname sends a POST request to register a new nickname, THEN THE Lottery_Service SHALL return a 409 error response indicating that a nickname has already been registered, and SHALL NOT modify the existing nickname
8. WHEN a participant who has already registered a nickname sends a GET request for their progress, THE Lottery_Service SHALL include the registered nickname in the response
9. WHEN a participant who has not registered a nickname accesses the Progress_Page after the Time_Gate and is lottery-eligible, THE Progress_Page SHALL prompt the participant to enter a nickname before they can participate in the lottery

### Requirement 4: Lottery Participant List API

**User Story:** As the lottery display system, I want to fetch all lottery participants with their nicknames, so that the 3D animation can render all eligible participants.

#### Acceptance Criteria

1. WHEN a GET request is received at /lottery/participants, THE Lottery_Service SHALL return a JSON response containing a count field (integer) representing the total number of participants and a participants array where each entry includes the participant's nickname
2. THE Lottery_Service SHALL return only participants who have both lottery eligibility (all 10 station check-ins completed AND at least one After_Party_Checkin) AND a registered nickname
3. THE Lottery_Service SHALL return the participant list within 3 seconds under an expected volume of up to 500 participants
4. WHEN no participants meet the eligibility criteria or no participants have registered nicknames, THE Lottery_Service SHALL return an empty participants array with a count of zero
5. THE Lottery_Service SHALL serve the /lottery/participants endpoint without requiring authentication, as it is accessed by the Lottery_Page display system which does not hold credentials
6. IF the Lottery_Service encounters an internal failure while retrieving the participant list, THEN THE Lottery_Service SHALL return a 500 error response with a message indicating a server error occurred

### Requirement 5: Lottery Draw Execution

**User Story:** As an event administrator, I want to trigger a lottery draw that randomly selects a winner from all eligible participants, so that prizes can be awarded during the After Party.

#### Acceptance Criteria

1. WHEN an authenticated administrator sends a POST request to /lottery/draw, THE Lottery_Service SHALL randomly select one winner from all current Lottery_Participants using a cryptographically secure random algorithm and return the response within 3 seconds
2. WHEN a winner is selected, THE Lottery_Service SHALL store the draw result with the winner's nickname, tagId, draw timestamp, and an auto-incremented draw sequence number, and return the winner's nickname, tagId, and draw sequence number in the response
3. IF no Lottery_Participants exist at the time of the draw, THEN THE Lottery_Service SHALL return a 400 error response indicating there are no eligible participants
4. THE Lottery_Service SHALL allow multiple draw executions (one per prize), each selecting from the full participant pool including previously selected winners
5. WHEN an authenticated administrator sends a GET request to /lottery/winners, THE Lottery_Service SHALL return the list of all past draw results in chronological order, each containing the winner nickname, tagId, draw timestamp, and draw sequence number, within 3 seconds
6. IF a non-authenticated user attempts to access POST /lottery/draw or GET /lottery/winners, THEN THE Lottery_Service SHALL return a 401 error response
7. IF two draw requests are received concurrently, THEN THE Lottery_Service SHALL process them sequentially, ensuring each draw receives a unique sequence number and each selection is made independently from the full participant pool
8. IF an authenticated administrator sends a GET request to /lottery/winners and no draws have been executed, THEN THE Lottery_Service SHALL return an empty list with a count of zero

### Requirement 6: 3D Lottery Animation — Letter Formation

**User Story:** As an event organizer, I want the lottery page to display all participant nicknames forming the letters "A", "W", "S" sequentially in 3D space, so that the audience sees an engaging visual build-up before the draw.

#### Acceptance Criteria

1. WHEN the Lottery_Page loads, THE Lottery_Page SHALL fetch the participant list from the /lottery/participants API and render each nickname (truncated to a maximum of 20 characters with ellipsis if exceeded) as a 3D text element using Three.js or equivalent WebGL library
2. IF the /lottery/participants API request fails or returns fewer than 10 participants, THEN THE Lottery_Page SHALL display an error message indicating the animation cannot be rendered and SHALL NOT attempt the letter formation sequence
3. WHEN the participant rendering completes, THE Lottery_Page SHALL automatically begin the animation sequence by arranging all nickname elements to form the letter "A" in 3D space within 2 seconds, with each nickname positioned as a building block of the letter shape
4. WHEN the letter "A" formation has held for 4 seconds, THE Lottery_Page SHALL transition all nickname elements to form the letter "W" with the transition completing within 2 seconds
5. WHEN the letter "W" formation has held for 4 seconds, THE Lottery_Page SHALL transition all nickname elements to form the letter "S" with the transition completing within 2 seconds
6. THE Lottery_Page SHALL display only one letter at a time, ensuring the previous letter disperses to opacity 0 before the next letter begins forming
7. WHILE the animation sequence is running, THE Lottery_Page SHALL maintain a minimum of 30 frames per second on a machine with a dedicated GPU released within the last 5 years

### Requirement 7: 3D Lottery Animation — Sphere and Noise Effect

**User Story:** As an event organizer, I want all nicknames to converge into a rotating sphere wrapped in noise after the letter sequence, so that the visual conveys the "Signal Over Noise" theme before the draw.

#### Acceptance Criteria

1. WHEN the letter "S" formation hold duration elapses, THE Lottery_Page SHALL transition all nickname elements into a spherical arrangement over a duration of 2 to 4 seconds, after which the sphere SHALL continuously rotate around its vertical axis at a rate of 5 to 15 degrees per second
2. WHILE the sphere is displayed, THE Lottery_Page SHALL wrap each nickname element in a Noise_Effect consisting of animated particle distortion or shader noise that obscures between 40% and 70% of each nickname's text area while leaving the remaining portion legible
3. THE Lottery_Page SHALL maintain the rotating sphere animation indefinitely until the administrator triggers a draw or navigates away
4. THE Lottery_Page SHALL render the sphere with ambient lighting and glow effects on a dark background using cyan and purple accent colors consistent with the existing "Signal Over Noise" visual design
5. IF the participant list contains fewer than 10 nicknames, THEN THE Lottery_Page SHALL reduce the sphere radius proportionally so that nickname elements remain visually dense rather than sparsely distributed
6. WHILE the sphere and Noise_Effect are active, THE Lottery_Page SHALL maintain a minimum frame rate of 30 frames per second on a machine with a dedicated GPU

### Requirement 8: 3D Lottery Animation — Winner Reveal (Signal)

**User Story:** As an event organizer, I want the winning participant's noise to dissolve into a clear "signal" highlight when drawn, so that the audience can clearly identify the winner in a dramatic reveal.

#### Acceptance Criteria

1. WHEN a draw result is received (via polling as defined in Requirement 9), THE Lottery_Page SHALL identify the winning nickname element in the sphere and begin the reveal animation sequence within 500 milliseconds of detection
2. IF the winning nickname from the draw result does not match any rendered nickname element in the sphere, THEN THE Lottery_Page SHALL display the winner's nickname as a new text element at the center of the sphere and proceed with the Signal_Reveal animation
3. WHEN the winner reveal animation begins, THE Lottery_Page SHALL animate the Noise_Effect on the winning nickname to dissolve (fade out particles, reduce distortion to zero) over 1 to 2 seconds
4. WHEN the Noise_Effect dissolution completes, THE Lottery_Page SHALL display the winner's nickname with a Signal_Reveal effect: glow outline, scale increased to at least 3x the base nickname size, color set to cyan (#7df9ff), and position elevated above the sphere center by at least one sphere radius
5. WHILE the winner is revealed, THE Lottery_Page SHALL reduce the opacity of all other nickname elements to 20% or lower to draw visual focus to the winner
6. WHEN the Signal_Reveal effect completes, THE Lottery_Page SHALL display the winner's nickname at a minimum font size of 48px equivalent at 1080p display resolution and hold the revealed state for at least 8 seconds before the system accepts the next draw result
7. WHEN a subsequent draw result is received after the hold period of a previous reveal, THE Lottery_Page SHALL return the previously revealed winner's nickname to the sphere at reduced opacity (50%), restore all other nicknames to full opacity, re-apply the Noise_Effect to all elements, and then begin the reveal sequence for the new winner

### Requirement 9: Lottery Page Connectivity

**User Story:** As an event operator, I want the lottery page to receive draw results in near real-time, so that the winner reveal animation plays immediately after the admin triggers a draw.

#### Acceptance Criteria

1. THE Lottery_Page SHALL poll the /lottery/winners endpoint every 3 seconds with a request timeout of 5 seconds to detect new draw results
2. WHEN a new winner is detected (the draw count returned by the endpoint exceeds the locally tracked count), THE Lottery_Page SHALL automatically trigger the winner reveal animation for each newly selected nickname in chronological draw order, queuing multiple reveals if more than one new winner is detected in a single poll response
3. IF the Lottery_Page receives 3 consecutive failed poll responses (network error, timeout, or HTTP 5xx status), THEN THE Lottery_Page SHALL transition the connection status indicator to a disconnected state, continue displaying the rotating sphere animation, and retry polling every 5 seconds until one successful response is received
4. WHEN a previously disconnected Lottery_Page receives a successful poll response, THE Lottery_Page SHALL transition the connection status indicator to a connected state and resume the standard 3-second polling interval
5. THE Lottery_Page SHALL display a connection status indicator that shows "connected" when the last successful poll response was received within the most recent 6 seconds, and "disconnected" otherwise

### Requirement 10: Progress Page Integration

**User Story:** As a lottery-eligible attendee, I want my progress page to show my lottery status and nickname input, so that I can register for the lottery from my existing progress view.

#### Acceptance Criteria

1. WHEN the Progress_Page is accessed after the Time_Gate AND the participant is lottery-eligible AND has no registered nickname, THE Progress_Page SHALL display a nickname input field accepting 1 to 20 characters with a submit button, and SHALL prevent submission of empty input, input exceeding 20 characters, or input containing only whitespace
2. WHEN the Progress_Page is accessed after the Time_Gate AND the participant has a registered nickname, THE Progress_Page SHALL display the registered nickname text alongside a visible enrollment-confirmed status label (in Simplified Chinese) indicating successful lottery registration
3. WHILE the current time is before the Time_Gate, THE Progress_Page SHALL NOT display any lottery-related UI elements (nickname input, lottery status, or eligibility information)
4. IF the Progress_Page is accessed after the Time_Gate AND the participant is not lottery-eligible (incomplete station visits or no After_Party_Checkin), THEN THE Progress_Page SHALL NOT display the nickname input form and SHALL display a status message in Simplified Chinese indicating which eligibility condition is unmet
5. WHEN a participant submits a nickname through the Progress_Page and receives a 409 conflict response, THE Progress_Page SHALL display an inline error message in Simplified Chinese indicating the nickname is already taken, SHALL preserve the submitted text in the input field, and SHALL allow the participant to edit and resubmit
6. IF a participant submits a nickname through the Progress_Page and receives a 400 response indicating invalid format, THEN THE Progress_Page SHALL display an inline error message in Simplified Chinese indicating the nickname format requirements (1 to 20 characters, no leading or trailing whitespace)
7. THE Progress_Page SHALL display all lottery-related text in Simplified Chinese, including labels, error messages, and status indicators
