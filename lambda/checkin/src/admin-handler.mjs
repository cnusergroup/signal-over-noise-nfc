/**
 * Admin handler — mission CRUD operations.
 * All admin routes require API key authentication (validated by router).
 *
 * Supports:
 * - POST /missions: Create a new mission
 * - GET /missions: List all missions
 * - GET /missions/{missionId}: Get mission details
 * - PUT /missions/{missionId}: Update a mission (only if not yet started)
 * - DELETE /missions/{missionId}: Delete a mission (only if not yet started)
 * - GET /missions/{missionId}/winners: Get mission winners
 */

import { GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import { getDocClient, getTableName, buildKeyCondition } from './utils/dynamo.mjs';
import { now, missionTTL, isoNow, toISO, fromISO } from './utils/time.mjs';
import { ok, created, noContent, notFound, conflict, internalError } from './utils/response.mjs';
import { v4 as uuidv4 } from 'uuid';

let schedulerClient = null;

/**
 * Sets the EventBridge Scheduler client (for testing).
 * @param {object|null} client
 */
export function setSchedulerClient(client) {
  schedulerClient = client;
}

/**
 * Gets the EventBridge Scheduler client.
 * @returns {object|null}
 */
function getSchedulerClient() {
  return schedulerClient;
}

/**
 * Generates a unique mission ID (UUID v4).
 * @returns {string}
 */
function generateMissionId() {
  return uuidv4();
}

/**
 * Computes the current status of a mission based on time.
 * @param {object} mission - Mission record
 * @returns {string} 'scheduled' | 'active' | 'completed'
 */
function computeStatus(mission) {
  // If status is explicitly set (e.g., completed by processor), use it
  if (mission.status === 'completed') return 'completed';

  const currentTime = now();
  const startMs = typeof mission.startTime === 'string'
    ? fromISO(mission.startTime)
    : mission.startTime;
  const endMs = typeof mission.endTime === 'string'
    ? fromISO(mission.endTime)
    : mission.endTime;

  if (currentTime < startMs) return 'scheduled';
  if (currentTime >= startMs && currentTime <= endMs) return 'active';
  return 'completed';
}

/**
 * Handles all mission admin operations.
 * @param {object} params - Route parameters
 * @param {string} params.method - HTTP method
 * @param {string} [params.missionId] - Mission identifier (for GET/PUT/DELETE single)
 * @param {string} [params.action] - Action type ('list', 'get', 'delete', 'winners')
 * @param {object} [params.body] - Request body (for POST/PUT)
 * @param {object} [deps] - Optional injected dependencies (for testing)
 * @returns {Promise<object>} Response object
 */
export async function handleMissionAdmin(params, deps) {
  const client = deps?.client || getDocClient();
  const tableName = deps?.tableName || getTableName();

  try {
    const { method, missionId, action, body } = params;

    // POST /missions — create
    if (method === 'POST' && !missionId) {
      return await createMission(body, client, tableName);
    }

    // GET /missions — list all
    if (method === 'GET' && action === 'list') {
      return await listMissions(client, tableName);
    }

    // GET /missions/active — list active missions (public)
    if (method === 'GET' && action === 'listActive') {
      return await listActiveMissions(client, tableName);
    }

    // GET /missions/{missionId}/winners
    if (method === 'GET' && action === 'winners' && missionId) {
      return await getMissionWinners(missionId, client, tableName);
    }

    // GET /missions/{missionId} — get single
    if (method === 'GET' && missionId) {
      return await getMission(missionId, client, tableName);
    }

    // PUT /missions/{missionId} — update
    if (method === 'PUT' && missionId) {
      return await updateMission(missionId, body, client, tableName);
    }

    // DELETE /missions/{missionId} — delete
    if (method === 'DELETE' && missionId) {
      return await deleteMission(missionId, client, tableName);
    }

    return internalError('Unsupported mission operation');
  } catch (err) {
    console.error('Admin handler error:', err);
    return internalError('Failed to process mission request');
  }
}

/**
 * Creates a new mission record.
 * Sets TTL = floor(endTime/1000) + 30*24*60*60.
 * Schedules EventBridge for lucky_draw and last_call missions.
 */
async function createMission(body, client, tableName) {
  const missionId = generateMissionId();
  const { type, name, startTime, endTime, stationId: rawStationId, milestones, winnerCount, prizeDescription, bonusPoints } = body;
  const stationId = rawStationId ? Number(rawStationId) : undefined;

  const endTimeMs = typeof endTime === 'string' ? fromISO(endTime) : endTime;
  const startTimeStr = typeof startTime === 'string' ? startTime : toISO(startTime);
  const endTimeStr = typeof endTime === 'string' ? endTime : toISO(endTime);
  const ttl = missionTTL(endTimeMs);

  const item = {
    PK: `MISSION#${missionId}`,
    SK: 'CONFIG',
    GSI1PK: `MISSION_TYPE#${type}`,
    GSI1SK: startTimeStr,
    missionId,
    type,
    name,
    startTime: startTimeStr,
    endTime: endTimeStr,
    stationId,
    status: 'scheduled',
    createdAt: isoNow(),
    ttl,
  };

  // Add type-specific fields
  if (milestones) item.milestones = milestones;
  if (winnerCount !== undefined) item.winnerCount = winnerCount;
  if (prizeDescription) item.prizeDescription = prizeDescription;
  if (bonusPoints !== undefined) item.bonusPoints = bonusPoints;

  await client.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  // Create counter record for numbered_visit and early_bird missions
  if (type === 'numbered_visit' || type === 'early_bird') {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `MISSION#${missionId}`,
        SK: 'COUNTER',
        visitorCount: 0,
        count: 0,
        ttl,
      },
    }));
  }

  // Schedule EventBridge for lucky_draw and last_call missions
  if (type === 'lucky_draw' || type === 'last_call') {
    await scheduleEndTimeEvent(missionId, type, endTimeStr);
  }

  return created({
    missionId,
    type,
    name,
    startTime: startTimeStr,
    endTime: endTimeStr,
    stationId,
    status: 'scheduled',
    ...(milestones && { milestones }),
    ...(winnerCount !== undefined && { winnerCount }),
    ...(prizeDescription && { prizeDescription }),
    ...(bonusPoints !== undefined && { bonusPoints }),
  });
}

/**
 * Schedules an EventBridge rule to trigger at mission end time.
 */
async function scheduleEndTimeEvent(missionId, type, endTimeStr) {
  const scheduler = getSchedulerClient();
  if (!scheduler) return;

  const targetArn = type === 'lucky_draw'
    ? process.env.LUCKY_DRAW_LAMBDA_ARN
    : process.env.LAST_CALL_LAMBDA_ARN;

  const roleArn = process.env.SCHEDULER_ROLE_ARN;
  const scheduleName = `mission-${missionId}-end`;

  try {
    await scheduler.send(new CreateScheduleCommand({
      Name: scheduleName,
      ScheduleExpression: `at(${endTimeStr.replace('Z', '')})`,
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: targetArn,
        RoleArn: roleArn,
        Input: JSON.stringify({ missionId }),
      },
      ActionAfterCompletion: 'DELETE',
    }));
  } catch (err) {
    console.error(`Failed to schedule end-time event for mission ${missionId}:`, err);
  }
}

/**
 * Deletes an EventBridge schedule for a mission.
 */
async function deleteScheduledEvent(missionId) {
  const scheduler = getSchedulerClient();
  if (!scheduler) return;

  const scheduleName = `mission-${missionId}-end`;

  try {
    await scheduler.send(new DeleteScheduleCommand({
      Name: scheduleName,
    }));
  } catch (err) {
    console.error(`Failed to delete schedule for mission ${missionId}:`, err);
  }
}

/**
 * Lists all missions by querying each mission type from GSI1.
 * Computes status based on current time.
 */
async function listMissions(client, tableName) {
  const missionTypes = ['numbered_visit', 'lucky_draw', 'early_bird', 'last_call'];
  const missions = [];

  for (const type of missionTypes) {
    try {
      const result = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `MISSION_TYPE#${type}` },
      }));

      if (result.Items) {
        for (const item of result.Items) {
          missions.push({
            missionId: item.missionId,
            name: item.name,
            type: item.type || type,
            status: computeStatus(item),
            startTime: item.startTime,
            endTime: item.endTime,
            stationId: item.stationId,
          });
        }
      }
    } catch (err) {
      console.error(`Error querying missions of type ${type}:`, err);
    }
  }

  return ok({ missions });
}

/**
 * Lists only active missions (public endpoint for participants).
 * Returns missions where current time is between startTime and endTime.
 */
async function listActiveMissions(client, tableName) {
  const missionTypes = ['numbered_visit', 'lucky_draw', 'early_bird', 'last_call'];
  const missions = [];

  for (const type of missionTypes) {
    try {
      const result = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `MISSION_TYPE#${type}` },
      }));

      if (result.Items) {
        for (const item of result.Items) {
          const status = computeStatus(item);
          if (status === 'active') {
            missions.push({
              missionId: item.missionId,
              name: item.name,
              type: item.type || type,
              status: 'active',
              startTime: item.startTime,
              endTime: item.endTime,
              stationId: item.stationId,
              prizeDescription: item.prizeDescription,
            });
          }
        }
      }
    } catch (err) {
      console.error(`Error querying active missions of type ${type}:`, err);
    }
  }

  return ok({ missions });
}

/**
 * Gets a single mission by ID. Computes status.
 */
async function getMission(missionId, client, tableName) {
  const result = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
  }));

  if (!result.Item) {
    return notFound('Mission not found');
  }

  const item = result.Item;
  return ok({
    missionId: item.missionId,
    type: item.type,
    name: item.name,
    startTime: item.startTime,
    endTime: item.endTime,
    stationId: item.stationId,
    status: computeStatus(item),
    ...(item.milestones && { milestones: item.milestones }),
    ...(item.winnerCount !== undefined && { winnerCount: item.winnerCount }),
    ...(item.prizeDescription && { prizeDescription: item.prizeDescription }),
    ...(item.bonusPoints !== undefined && { bonusPoints: item.bonusPoints }),
    ...(item.actualWinnerCount !== undefined && { actualWinnerCount: item.actualWinnerCount }),
    ...(item.completedAt && { completedAt: item.completedAt }),
  });
}

/**
 * Updates a mission (only if not yet started).
 */
async function updateMission(missionId, body, client, tableName) {
  // Fetch existing mission
  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
  }));

  if (!existing.Item) {
    return notFound('Mission not found');
  }

  const mission = existing.Item;
  const currentTime = now();
  const startTimeMs = typeof mission.startTime === 'string'
    ? fromISO(mission.startTime)
    : mission.startTime;

  // Reject if mission has started or ended
  if (currentTime >= startTimeMs) {
    return conflict('Cannot modify a mission that is active or has ended');
  }

  // Build update expression
  const updates = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.startTime !== undefined) updates.startTime = typeof body.startTime === 'string' ? body.startTime : toISO(body.startTime);
  if (body.endTime !== undefined) updates.endTime = typeof body.endTime === 'string' ? body.endTime : toISO(body.endTime);
  if (body.stationId !== undefined) updates.stationId = body.stationId;
  if (body.milestones !== undefined) updates.milestones = body.milestones;
  if (body.winnerCount !== undefined) updates.winnerCount = body.winnerCount;
  if (body.prizeDescription !== undefined) updates.prizeDescription = body.prizeDescription;
  if (body.bonusPoints !== undefined) updates.bonusPoints = body.bonusPoints;

  // Recalculate TTL if endTime changed
  if (body.endTime !== undefined) {
    const newEndTimeMs = typeof body.endTime === 'string' ? fromISO(body.endTime) : body.endTime;
    updates.ttl = missionTTL(newEndTimeMs);
  }

  if (Object.keys(updates).length === 0) {
    return ok({ missionId, ...formatMissionResponse(mission) });
  }

  // Build DynamoDB update expression
  const expressionParts = [];
  const expressionNames = {};
  const expressionValues = {};

  Object.entries(updates).forEach(([key, value], index) => {
    const nameKey = `#f${index}`;
    const valueKey = `:v${index}`;
    expressionParts.push(`${nameKey} = ${valueKey}`);
    expressionNames[nameKey] = key;
    expressionValues[valueKey] = value;
  });

  await client.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
  }));

  // Re-read the updated item
  const updatedResult = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
  }));

  const updated = updatedResult.Item || { ...mission, ...updates };
  return ok(formatMissionResponse(updated));
}

/**
 * Formats a mission record for API response.
 */
function formatMissionResponse(item) {
  return {
    missionId: item.missionId,
    type: item.type,
    name: item.name,
    startTime: item.startTime,
    endTime: item.endTime,
    stationId: item.stationId,
    status: computeStatus(item),
    ...(item.milestones && { milestones: item.milestones }),
    ...(item.winnerCount !== undefined && { winnerCount: item.winnerCount }),
    ...(item.prizeDescription && { prizeDescription: item.prizeDescription }),
    ...(item.bonusPoints !== undefined && { bonusPoints: item.bonusPoints }),
  };
}

/**
 * Deletes a mission (only if not yet started).
 * Also deletes counter record and scheduled events.
 */
async function deleteMission(missionId, client, tableName) {
  // Fetch existing mission
  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
  }));

  if (!existing.Item) {
    return notFound('Mission not found');
  }

  const mission = existing.Item;
  const currentTime = now();
  const startTimeMs = typeof mission.startTime === 'string'
    ? fromISO(mission.startTime)
    : mission.startTime;

  // Reject if mission has started or ended
  if (currentTime >= startTimeMs) {
    return conflict('Cannot delete a mission that is active or has ended');
  }

  // Delete the config record
  await client.send(new DeleteCommand({
    TableName: tableName,
    Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
  }));

  // Delete counter record if it exists
  try {
    await client.send(new DeleteCommand({
      TableName: tableName,
      Key: { PK: `MISSION#${missionId}`, SK: 'COUNTER' },
    }));
  } catch {
    // Ignore — counter may not exist
  }

  // Delete scheduled event for lucky_draw and last_call
  if (mission.type === 'lucky_draw' || mission.type === 'last_call') {
    await deleteScheduledEvent(missionId);
  }

  return noContent();
}

/**
 * Gets winners for a mission.
 * For numbered_visit: returns entries that hit milestones.
 * For early_bird: returns EARLYBIRD# slot records.
 * For lucky_draw/last_call: returns WINNER# records.
 */
async function getMissionWinners(missionId, client, tableName) {
  // Verify mission exists
  const configResult = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
  }));

  if (!configResult.Item) {
    return notFound('Mission not found');
  }

  const missionConfig = configResult.Item;
  const missionType = missionConfig.type;
  let winners = [];

  if (missionType === 'numbered_visit') {
    // Query all ENTRY# records and filter for milestone hits
    const entryCondition = buildKeyCondition(`MISSION#${missionId}`, { beginsWith: 'ENTRY#' });
    const entryResult = await client.send(new QueryCommand({
      TableName: tableName,
      ...entryCondition,
    }));
    const milestones = missionConfig.milestones || [];
    winners = (entryResult.Items || [])
      .filter(item => item.visitorNumber && milestones.includes(item.visitorNumber))
      .map(item => ({
        tagId: item.tagId,
        visitorNumber: item.visitorNumber,
        milestone: true,
        awardedAt: item.awardedAt,
      }));
  } else if (missionType === 'early_bird') {
    // Query EARLYBIRD# records
    const ebCondition = buildKeyCondition(`MISSION#${missionId}`, { beginsWith: 'EARLYBIRD#' });
    const ebResult = await client.send(new QueryCommand({
      TableName: tableName,
      ...ebCondition,
    }));
    winners = (ebResult.Items || []).map(item => ({
      tagId: item.tagId,
      position: item.position,
      bonusPoints: item.bonusPoints,
      awardedAt: item.awardedAt,
    }));
  } else {
    // lucky_draw / last_call: query WINNER# records
    const keyCondition = buildKeyCondition(`MISSION#${missionId}`, { beginsWith: 'WINNER#' });
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      ...keyCondition,
    }));
    winners = (result.Items || []).map(item => ({
      tagId: item.tagId,
      ...(item.awardedAt && { awardedAt: item.awardedAt }),
      ...(item.prizeDescription && { prizeDescription: item.prizeDescription }),
      ...(item.checkinTime && { checkinTime: item.checkinTime }),
    }));
  }

  return ok({
    missionId,
    missionName: missionConfig.name,
    type: missionType,
    status: computeStatus(missionConfig),
    winners,
    totalWinners: winners.length,
  });
}
