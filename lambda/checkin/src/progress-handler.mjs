/**
 * Progress handler — queries check-in progress for a given NFC tag.
 * Returns stations visited, total count, completion status, and reward code.
 */

import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, buildKeyCondition, buildKey } from './utils/dynamo.mjs';
import { filterExpired, now, getAfterPartyTimeGateMs } from './utils/time.mjs';
import { ok, missingField, internalError } from './utils/response.mjs';
import { loadLotteryConfig } from './lottery-handler.mjs';

const TOTAL_STATIONS = 10;

/**
 * Handles GET /checkin/{tagId} requests.
 * @param {string} tagId - NFC tag identifier
 * @returns {Promise<object>} Response object
 */
export async function handleProgress(tagId) {
  // 1. Validate tagId is non-empty
  if (!tagId || (typeof tagId === 'string' && tagId.trim() === '')) {
    return missingField('tagId');
  }

  const client = getDocClient();
  const tableName = getTableName();

  // 2. Query all check-ins for this tag
  let checkinItems;
  try {
    const keyCondition = buildKeyCondition(`TAG#${tagId}`, { beginsWith: 'CHECKIN#' });
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      ...keyCondition,
    }));
    checkinItems = result.Items || [];
  } catch (err) {
    console.error('DynamoDB error querying check-ins for tag:', err);
    return internalError('Failed to query check-in progress');
  }

  // 3. Filter out expired records (TTL < current time)
  const validCheckins = filterExpired(checkinItems);

  // 4. Build stations list sorted by stationId ascending
  const stations = validCheckins
    .map(item => ({
      stationId: item.stationId,
      checkinTime: item.checkinTime,
    }))
    .sort((a, b) => a.stationId - b.stationId);

  const totalCheckins = stations.length;
  const completed = totalCheckins === TOTAL_STATIONS;

  // 5. Check for a dedicated AFTER_PARTY record (written when a check-in happens
  //    after the admin-configured time gate). This is the authoritative "入场打卡"
  //    for lottery eligibility, separate from regular station check-ins.
  let afterPartyEligible = false;
  try {
    const apResult = await client.send(new GetCommand({
      TableName: tableName,
      Key: buildKey(`TAG#${tagId}`, 'AFTER_PARTY'),
    }));
    afterPartyEligible = !!apResult.Item;
  } catch (err) {
    console.error('DynamoDB error checking AFTER_PARTY record:', err);
    // Non-fatal: default to false
  }

  // Reload the admin-configurable time gate from DynamoDB so that changes made
  // via POST /lottery/config take effect across all Lambda instances immediately.
  await loadLotteryConfig();

  // Determine whether the current time is before the After Party time gate.
  // Per Requirement 2.5, no lottery-related fields are returned before the gate.
  const beforeGate = now() < getAfterPartyTimeGateMs();

  // 6. Compute lottery eligibility and a machine-readable reason (only meaningful
  //    once the time gate has passed). The four branches mirror the design:
  //    - completed && afterPartyEligible        → eligible, no reason
  //    - !completed && !afterPartyEligible       → incomplete_stations_and_no_after_party_checkin
  //    - !completed (but has after-party check-in) → incomplete_stations
  //    - else (completed but no after-party)      → after_party_checkin_required
  let lotteryEligible = false;
  let lotteryReason = null;
  if (!beforeGate) {
    if (completed && afterPartyEligible) {
      lotteryEligible = true;
    } else if (!completed && !afterPartyEligible) {
      lotteryEligible = false;
      lotteryReason = 'incomplete_stations_and_no_after_party_checkin';
    } else if (!completed) {
      lotteryEligible = false;
      lotteryReason = 'incomplete_stations';
    } else {
      lotteryEligible = false;
      lotteryReason = 'after_party_checkin_required';
    }
  }

  // 7. If stamp rally complete, fetch reward code from stamp rally record
  let rewardCode = null;
  if (completed) {
    try {
      const stampRallyResult = await client.send(new GetCommand({
        TableName: tableName,
        Key: buildKey(`TAG#${tagId}`, 'STAMPRALLY'),
      }));
      if (stampRallyResult.Item && stampRallyResult.Item.rewardCode) {
        rewardCode = stampRallyResult.Item.rewardCode;
      }
    } catch (err) {
      // Non-fatal: stamp rally record may not exist yet
      console.error('DynamoDB error fetching stamp rally record:', err);
    }
  }

  // 8. Look up the registered nickname (best-effort). Only attempted after the
  //    time gate, since the lottery is not open before it.
  let nickname = null;
  if (!beforeGate) {
    try {
      const nickResult = await client.send(new GetCommand({
        TableName: tableName,
        Key: buildKey(`TAG#${tagId}`, 'NICKNAME'),
      }));
      if (nickResult.Item && nickResult.Item.nickname) {
        nickname = nickResult.Item.nickname;
      }
    } catch (err) {
      // Non-fatal: nickname record may not exist yet
      console.error('DynamoDB error fetching nickname record:', err);
    }
  }

  // 9. Build the progress response. Lottery fields are omitted entirely before
  //    the time gate (Requirement 2.5); nickname is attached only when present.
  const responseBody = {
    tagId,
    totalCheckins,
    completed,
    rewardCode,
    stations,
    afterPartyEligible,
    stationsRemaining: completed ? 0 : (TOTAL_STATIONS - totalCheckins),
  };

  if (!beforeGate) {
    responseBody.lotteryEligible = lotteryEligible;
    if (lotteryReason) responseBody.lotteryReason = lotteryReason;
    if (nickname) responseBody.nickname = nickname;
  }

  return ok(responseBody);
}
