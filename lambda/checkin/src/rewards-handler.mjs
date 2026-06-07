/**
 * Rewards handler — queries all rewards/wins for a given NFC tag.
 * Returns mission wins, early bird bonuses, combo awards, and stamp rally status.
 */

import { QueryCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, buildKeyCondition, buildGSIKeyCondition } from './utils/dynamo.mjs';
import { filterExpired } from './utils/time.mjs';
import { ok, missingField, internalError } from './utils/response.mjs';

async function checkRedemptionStatus(tagId, rewardKey, client, tableName) {
  try {
    const result = await client.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `TAG#${tagId}`, SK: `REDEMPTION#${rewardKey}` },
    }));
    return result.Item ? { redeemed: true, redeemedAt: result.Item.redeemedAt } : { redeemed: false };
  } catch { return { redeemed: false }; }
}

export async function handleRedeemReward(body) {
  if (!body || !body.tagId || !body.rewardKey) {
    return missingField('tagId or rewardKey');
  }

  const { tagId, rewardKey } = body;
  const client = getDocClient();
  const tableName = getTableName();

  // rewardKey format: "stamp_rally", "combo:{name}", "milestone:{missionId}", "early_bird:{missionId}", "winner:{missionId}"
  const redemptionSK = `REDEMPTION#${rewardKey}`;

  // Check if already redeemed
  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `TAG#${tagId}`, SK: redemptionSK },
  }));

  if (existing.Item) {
    return ok({ 
      tagId, 
      rewardKey, 
      status: 'already_redeemed', 
      redeemedAt: existing.Item.redeemedAt 
    });
  }

  // Mark as redeemed
  await client.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `TAG#${tagId}`,
      SK: redemptionSK,
      tagId,
      rewardKey,
      redeemedAt: new Date().toISOString(),
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  return ok({ tagId, rewardKey, status: 'redeemed', redeemedAt: new Date().toISOString() });
}

export async function handleRewards(tagId) {
  if (!tagId || (typeof tagId === 'string' && tagId.trim() === '')) {
    return missingField('tagId');
  }

  const client = getDocClient();
  const tableName = getTableName();
  const rewards = [];

  try {
    // 1. Check stamp rally completion
    const stampRallyResult = await client.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `TAG#${tagId}`, SK: 'STAMPRALLY' },
    }));
    if (stampRallyResult.Item) {
      const rewardKey = 'stamp_rally';
      const redemption = await checkRedemptionStatus(tagId, rewardKey, client, tableName);
      rewards.push({
        type: 'stamp_rally',
        name: 'Stamp Rally 集邮完成',
        rewardCode: stampRallyResult.Item.rewardCode,
        completedAt: stampRallyResult.Item.completedAt,
        rewardKey,
        ...redemption,
      });
    }

    // 2. Check combo awards
    const comboResult = await client.send(new QueryCommand({
      TableName: tableName,
      ...buildKeyCondition(`TAG#${tagId}`, { beginsWith: 'COMBO#' }),
    }));
    if (comboResult.Items) {
      for (const item of comboResult.Items) {
        const comboName = item.comboName || item.SK.replace('COMBO#', '');
        const rewardKey = `combo:${comboName}`;
        const redemption = await checkRedemptionStatus(tagId, rewardKey, client, tableName);
        rewards.push({
          type: 'combo',
          name: comboName,
          reward: item.reward,
          stations: item.stations,
          awardedAt: item.awardedAt,
          rewardKey,
          ...redemption,
        });
      }
    }

    // 3. Check mission entries (via GSI1: TAG#{tagId} → MISSION#{missionId})
    const entriesResult = await client.send(new QueryCommand({
      TableName: tableName,
      ...buildGSIKeyCondition('GSI1', `TAG#${tagId}`, { beginsWith: 'MISSION#' }),
    }));

    if (entriesResult.Items) {
      for (const entry of entriesResult.Items) {
        const missionId = entry.GSI1SK ? entry.GSI1SK.replace('MISSION#', '') : null;
        if (!missionId) continue;

        // Check if this tag is a winner in this mission
        const winnerResult = await client.send(new GetCommand({
          TableName: tableName,
          Key: { PK: `MISSION#${missionId}`, SK: `WINNER#${tagId}` },
        }));

        if (winnerResult.Item) {
          // Get mission name
          const configResult = await client.send(new GetCommand({
            TableName: tableName,
            Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
          }));
          const missionName = configResult.Item?.name || missionId;
          const missionType = configResult.Item?.type || 'unknown';

          const rewardKey = `winner:${missionId}`;
          const redemption = await checkRedemptionStatus(tagId, rewardKey, client, tableName);
          rewards.push({
            type: 'mission_winner',
            missionType,
            missionName,
            missionId,
            prizeDescription: winnerResult.Item.prizeDescription || configResult.Item?.prizeDescription,
            awardedAt: winnerResult.Item.awardedAt,
            rewardKey,
            ...redemption,
          });
        }

        // Check early bird award
        if (entry.earlyBirdPosition) {
          const configResult = await client.send(new GetCommand({
            TableName: tableName,
            Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
          }));
          const missionName = configResult.Item?.name || missionId;

          const rewardKey = `early_bird:${missionId}`;
          const redemption = await checkRedemptionStatus(tagId, rewardKey, client, tableName);
          rewards.push({
            type: 'early_bird',
            missionName,
            missionId,
            position: entry.earlyBirdPosition,
            bonusPoints: entry.bonusPoints,
            awardedAt: entry.awardedAt,
            rewardKey,
            ...redemption,
          });
        }

        // Check numbered visit milestone
        if (entry.visitorNumber) {
          const configResult = await client.send(new GetCommand({
            TableName: tableName,
            Key: { PK: `MISSION#${missionId}`, SK: 'CONFIG' },
          }));
          const milestones = configResult.Item?.milestones || [];
          if (milestones.includes(entry.visitorNumber)) {
            const rewardKey = `milestone:${missionId}`;
            const redemption = await checkRedemptionStatus(tagId, rewardKey, client, tableName);
            rewards.push({
              type: 'milestone',
              missionName: configResult.Item?.name || missionId,
              missionId,
              visitorNumber: entry.visitorNumber,
              stationId: configResult.Item?.stationId,
              prizeDescription: configResult.Item?.prizeDescription,
              awardedAt: entry.awardedAt,
              rewardKey,
              ...redemption,
            });
          }
        }
      }
    }

    return ok({ tagId, rewards, totalRewards: rewards.length });
  } catch (err) {
    console.error('Error querying rewards:', err);
    return internalError('Failed to query rewards');
  }
}
