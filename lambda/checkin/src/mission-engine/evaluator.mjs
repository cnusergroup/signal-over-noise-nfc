/**
 * Mission evaluator orchestrator — coordinates mission evaluation during check-in.
 * Queries active missions for the station and delegates to individual processors.
 * Handles graceful degradation: if a processor fails, check-in still succeeds.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, buildGSIKeyCondition } from '../utils/dynamo.mjs';
import { now } from '../utils/time.mjs';
import { processNumberedVisit } from './numbered-visit.mjs';
import { recordLuckyDrawEntry } from './lucky-draw.mjs';
import { processEarlyBird } from './early-bird.mjs';
import { recordLastCallEntry } from './last-call.mjs';
import { evaluateStampRally } from './stamp-rally.mjs';
import { evaluateCombos } from './combo.mjs';

/**
 * Queries active missions for a given station from DynamoDB.
 * Active missions have status 'active' or 'scheduled' and current time is within [startTime, endTime].
 * Uses GSI1 with partition key MISSION_TYPE#{type} to find missions by type.
 *
 * @param {number} stationId - Station identifier
 * @param {number} currentTime - Current time in milliseconds
 * @returns {Promise<Array>} List of active mission configs
 */
async function queryActiveMissions(stationId, currentTime) {
  const client = getDocClient();
  const tableName = getTableName();
  const missionTypes = ['numbered_visit', 'lucky_draw', 'early_bird', 'last_call'];
  const activeMissions = [];

  for (const type of missionTypes) {
    try {
      const gsiCondition = buildGSIKeyCondition('GSI1', `MISSION_TYPE#${type}`);
      const result = await client.send(new QueryCommand({
        TableName: tableName,
        ...gsiCondition,
      }));

      if (result.Items) {
        for (const mission of result.Items) {
          // Filter by station and time window
          if (Number(mission.stationId) !== Number(stationId)) continue;
          if (mission.status !== 'active' && mission.status !== 'scheduled') continue;

          const startMs = typeof mission.startTime === 'string'
            ? new Date(mission.startTime).getTime()
            : mission.startTime;
          const endMs = typeof mission.endTime === 'string'
            ? new Date(mission.endTime).getTime()
            : mission.endTime;

          if (currentTime >= startMs && currentTime <= endMs) {
            activeMissions.push({ ...mission, type });
          }
        }
      }
    } catch (err) {
      // Log but don't fail — graceful degradation
      console.error(`Error querying missions of type ${type}:`, err);
    }
  }

  return activeMissions;
}

/**
 * Dispatches a mission to the appropriate processor based on its type.
 *
 * @param {object} mission - Mission configuration record
 * @param {object} context - Check-in context { tagId, stationId, checkinTime, isNewCheckin }
 * @returns {Promise<{ type: string, result: any }>} Processor result
 */
async function dispatchMission(mission, context) {
  const { tagId, checkinTime } = context;
  const deps = { client: getDocClient(), tableName: getTableName() };

  switch (mission.type) {
    case 'numbered_visit': {
      const result = await processNumberedVisit(mission, tagId, deps);
      return { type: 'numbered_visit', result };
    }
    case 'lucky_draw': {
      const result = await recordLuckyDrawEntry(mission, tagId, deps);
      return { type: 'lucky_draw', result };
    }
    case 'early_bird': {
      const result = await processEarlyBird(mission, tagId, deps);
      return { type: 'early_bird', result };
    }
    case 'last_call': {
      const result = await recordLastCallEntry(mission, tagId, checkinTime, deps);
      return { type: 'last_call', result };
    }
    default:
      throw new Error(`Unknown mission type: ${mission.type}`);
  }
}

/**
 * Evaluates all active missions for a given check-in.
 * Orchestrates calls to individual mission processors and aggregates results.
 * Graceful degradation: if any processor fails, the error is captured in missionErrors
 * but the overall evaluation continues.
 *
 * @param {object} params - Check-in context
 * @param {string} params.tagId - NFC tag identifier
 * @param {number} params.stationId - Station identifier (1–10)
 * @param {string} params.checkinTime - ISO 8601 check-in timestamp
 * @param {boolean} params.isNewCheckin - Whether this is a new check-in (not cooldown)
 * @returns {Promise<object>} Aggregated missions response object
 */
export async function evaluateMissions({ tagId, stationId, checkinTime, isNewCheckin }) {
  const currentTime = now();
  const missionErrors = [];

  // Result accumulators
  const numberedVisit = [];
  let luckyDraw = null;
  let earlyBird = null;
  let lastCall = null;
  let comboCompleted = [];
  let stampRally = { completed: false, rewardCode: null };

  // 1. Query active missions for this station
  let activeMissions = [];
  try {
    activeMissions = await queryActiveMissions(stationId, currentTime);
  } catch (err) {
    console.error('Error querying active missions:', err);
    missionErrors.push({
      phase: 'query',
      message: 'Failed to query active missions',
    });
  }

  // 2. Dispatch each active mission to its processor
  for (const mission of activeMissions) {
    try {
      const { type, result } = await dispatchMission(mission, { tagId, stationId, checkinTime, isNewCheckin });

      switch (type) {
        case 'numbered_visit':
          if (result) numberedVisit.push(result);
          break;
        case 'lucky_draw':
          if (result) luckyDraw = result;
          break;
        case 'early_bird':
          if (result) earlyBird = result;
          break;
        case 'last_call':
          if (result) lastCall = result;
          break;
      }
    } catch (err) {
      console.error(`Error processing mission ${mission.PK} (${mission.type}):`, err);
      missionErrors.push({
        missionId: mission.missionId || mission.PK,
        type: mission.type,
        message: err.message || 'Mission processor failed',
      });
    }
  }

  // 3. Evaluate stamp rally (always, not mission-specific)
  try {
    stampRally = await evaluateStampRally(tagId, {
      client: getDocClient(),
      tableName: getTableName(),
    });
  } catch (err) {
    console.error('Error evaluating stamp rally:', err);
    missionErrors.push({
      phase: 'stamp_rally',
      message: err.message || 'Stamp rally evaluation failed',
    });
  }

  // 4. Evaluate combos (always, not mission-specific)
  try {
    comboCompleted = await evaluateCombos(tagId, undefined, {
      client: getDocClient(),
      tableName: getTableName(),
    });
  } catch (err) {
    console.error('Error evaluating combos:', err);
    missionErrors.push({
      phase: 'combo',
      message: err.message || 'Combo evaluation failed',
    });
  }

  // 5. Build aggregated response
  const result = {
    numberedVisit,
    luckyDraw,
    earlyBird,
    lastCall,
    comboCompleted,
    stampRally,
  };

  // Only include missionErrors if there were errors
  if (missionErrors.length > 0) {
    result.missionErrors = missionErrors;
  }

  return result;
}
