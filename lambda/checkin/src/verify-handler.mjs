/**
 * Verify handler — handles one-time lunch and party verification for staff,
 * plus entitlement management (set/remove/get).
 */

import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, buildKey } from './utils/dynamo.mjs';
import * as response from './utils/response.mjs';

/**
 * Checks if the user belongs to the "staff" or "admin" group.
 */
function isStaffOrAdmin(claims) {
  if (!claims) return false;
  const groups = claims['cognito:groups'];
  if (!groups) return false;
  let groupList;
  if (Array.isArray(groups)) {
    groupList = groups;
  } else if (typeof groups === 'string') {
    // Cognito may return "[admin, staff]" or "[admin]" or "admin" 
    const cleaned = groups.replace(/^\[|\]$/g, '').trim();
    groupList = cleaned ? cleaned.split(/\s*,\s*/) : [];
  } else {
    groupList = [];
  }
  return groupList.includes('staff') || groupList.includes('admin');
}

/**
 * Handles POST /verify/lunch and POST /verify/party.
 */
export async function handleVerify({ type, body, claims }) {
  // 1. Authorization
  if (!isStaffOrAdmin(claims)) {
    return response.buildErrorResponse(403, 'forbidden', 'Staff or admin group membership required');
  }

  // 2. Validate
  if (!body || !body.tagId || (typeof body.tagId === 'string' && body.tagId.trim() === '')) {
    return response.missingField('tagId');
  }

  const tagId = body.tagId.trim();
  const sk = type.toUpperCase(); // 'LUNCH' or 'PARTY'
  const client = getDocClient();
  const tableName = getTableName();

  // 3. Check entitlement
  const entitlementSK = `ENTITLEMENT_${sk}`; // ENTITLEMENT_LUNCH or ENTITLEMENT_PARTY
  const entitlement = await client.send(new GetCommand({
    TableName: tableName,
    Key: buildKey(`TAG#${tagId}`, entitlementSK),
  }));

  if (!entitlement.Item) {
    return response.buildErrorResponse(403, 'not_entitled',
      `Tag ${tagId} does not have ${type} entitlement`);
  }

  // 4. Check existing
  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: buildKey(`TAG#${tagId}`, sk),
  }));

  if (existing.Item) {
    return response.buildErrorResponse(409, 'already_verified',
      `Tag ${tagId} has already been verified for ${type}`);
  }

  // 5. Create record
  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `TAG#${tagId}`,
        SK: sk,
        tagId,
        type,
        verifiedAt: new Date().toISOString(),
        verifiedBy: claims?.email || claims?.sub || 'unknown',
      },
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return response.buildErrorResponse(409, 'already_verified',
        `Tag ${tagId} has already been verified for ${type}`);
    }
    throw err;
  }

  return response.ok({
    success: true,
    tagId,
    type,
    verifiedAt: new Date().toISOString(),
  });
}

/**
 * Sets an entitlement for a participant (lunch or party eligibility).
 * POST /entitlement/set
 */
export async function handleSetEntitlement({ body, claims }) {
  if (!isStaffOrAdmin(claims)) {
    return response.buildErrorResponse(403, 'forbidden', 'Staff or admin group membership required');
  }

  if (!body || !body.tagId || !body.type) {
    return response.missingField(body?.tagId ? 'type' : 'tagId');
  }

  const tagId = body.tagId.trim();
  const type = body.type; // 'lunch' or 'party'
  if (!['lunch', 'party'].includes(type)) {
    return response.buildErrorResponse(400, 'invalid_field', 'Type must be "lunch" or "party"');
  }

  const client = getDocClient();
  const tableName = getTableName();
  const sk = `ENTITLEMENT_${type.toUpperCase()}`; // ENTITLEMENT_LUNCH or ENTITLEMENT_PARTY

  // Check if already set
  const existing = await client.send(new GetCommand({
    TableName: tableName,
    Key: buildKey(`TAG#${tagId}`, sk),
  }));

  if (existing.Item) {
    return response.ok({ tagId, type, status: 'already_set', setAt: existing.Item.setAt });
  }

  await client.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `TAG#${tagId}`,
      SK: sk,
      tagId,
      type,
      setAt: new Date().toISOString(),
      setBy: claims?.email || claims?.sub || 'unknown',
    },
  }));

  return response.ok({ tagId, type, status: 'set', setAt: new Date().toISOString() });
}

/**
 * Removes an entitlement for a participant.
 * POST /entitlement/remove
 */
export async function handleRemoveEntitlement({ body, claims }) {
  if (!isStaffOrAdmin(claims)) {
    return response.buildErrorResponse(403, 'forbidden', 'Staff or admin group membership required');
  }

  if (!body || !body.tagId || !body.type) {
    return response.missingField(body?.tagId ? 'type' : 'tagId');
  }

  const tagId = body.tagId.trim();
  const type = body.type;
  if (!['lunch', 'party'].includes(type)) {
    return response.buildErrorResponse(400, 'invalid_field', 'Type must be "lunch" or "party"');
  }

  const client = getDocClient();
  const tableName = getTableName();
  const sk = `ENTITLEMENT_${type.toUpperCase()}`;

  await client.send(new DeleteCommand({
    TableName: tableName,
    Key: buildKey(`TAG#${tagId}`, sk),
  }));

  return response.ok({ tagId, type, status: 'removed' });
}

/**
 * Gets entitlements and verification status for a participant.
 * GET /entitlement/{tagId}
 */
export async function handleGetEntitlement(tagId) {
  if (!tagId || tagId.trim() === '') {
    return response.missingField('tagId');
  }

  const client = getDocClient();
  const tableName = getTableName();

  const results = {
    tagId,
    lunch: { entitled: false, verified: false },
    party: { entitled: false, verified: false },
  };

  // Check lunch entitlement
  const lunchEntitlement = await client.send(new GetCommand({
    TableName: tableName,
    Key: buildKey(`TAG#${tagId}`, 'ENTITLEMENT_LUNCH'),
  }));
  if (lunchEntitlement.Item) {
    results.lunch.entitled = true;
    results.lunch.setAt = lunchEntitlement.Item.setAt;
  }

  // Check lunch verification
  const lunchVerify = await client.send(new GetCommand({
    TableName: tableName,
    Key: buildKey(`TAG#${tagId}`, 'LUNCH'),
  }));
  if (lunchVerify.Item) {
    results.lunch.verified = true;
    results.lunch.verifiedAt = lunchVerify.Item.verifiedAt;
  }

  // Check party entitlement
  const partyEntitlement = await client.send(new GetCommand({
    TableName: tableName,
    Key: buildKey(`TAG#${tagId}`, 'ENTITLEMENT_PARTY'),
  }));
  if (partyEntitlement.Item) {
    results.party.entitled = true;
    results.party.setAt = partyEntitlement.Item.setAt;
  }

  // Check party verification
  const partyVerify = await client.send(new GetCommand({
    TableName: tableName,
    Key: buildKey(`TAG#${tagId}`, 'PARTY'),
  }));
  if (partyVerify.Item) {
    results.party.verified = true;
    results.party.verifiedAt = partyVerify.Item.verifiedAt;
  }

  return response.ok(results);
}
