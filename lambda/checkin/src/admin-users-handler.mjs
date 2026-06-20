/**
 * Admin user management — list / create / reset-password / delete
 * staff (volunteer) and exhibitor Cognito accounts.
 *
 * Routes (all admin-only, JWT enforced by API Gateway):
 *   GET  /admin/users           → list staff + exhibitor accounts
 *   POST /admin/users           → create an account { email, group, password, stationId? }
 *   POST /admin/users/password  → reset a password { email, password }
 *   POST /admin/users/delete    → delete an account { email }
 */

import {
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ok, error, missingField } from './utils/response.mjs';

const MANAGED_GROUPS = ['staff', 'exhibitor'];
const cognito = new CognitoIdentityProviderClient({});

function getUserPoolId() {
  return process.env.USER_POOL_ID;
}

/** Returns true if the caller belongs to the `admin` Cognito group. */
function isAdmin(claims) {
  if (!claims) return false;
  const groups = claims['cognito:groups'];
  if (!groups) return false;
  let list;
  if (Array.isArray(groups)) list = groups;
  else if (typeof groups === 'string') {
    const cleaned = groups.replace(/^\[|\]$/g, '').trim();
    list = cleaned ? cleaned.split(/\s*,\s*/) : [];
  } else list = [];
  return list.includes('admin');
}

/** Extracts a named attribute value from a Cognito user's Attributes array. */
function attr(user, name) {
  const found = (user.Attributes || user.UserAttributes || []).find((a) => a.Name === name);
  return found ? found.Value : null;
}

/**
 * GET /admin/users — list all staff and exhibitor accounts.
 */
export async function handleListUsers(claims) {
  if (!isAdmin(claims)) return error(403, 'forbidden', 'Admin group membership required');
  const userPoolId = getUserPoolId();
  if (!userPoolId) return error(500, 'internal_error', 'USER_POOL_ID not configured');

  try {
    const users = [];
    for (const group of MANAGED_GROUPS) {
      let nextToken;
      do {
        const res = await cognito.send(new ListUsersInGroupCommand({
          UserPoolId: userPoolId,
          GroupName: group,
          NextToken: nextToken,
        }));
        for (const u of res.Users || []) {
          users.push({
            email: attr(u, 'email') || u.Username,
            group,
            stationId: attr(u, 'custom:stationId'),
            status: u.UserStatus,
            enabled: u.Enabled,
          });
        }
        nextToken = res.NextToken;
      } while (nextToken);
    }
    // Sort by group then email for a stable display order.
    users.sort((a, b) => (a.group + a.email).localeCompare(b.group + b.email));
    return ok({ count: users.length, users });
  } catch (err) {
    console.error('List users error:', err);
    return error(500, 'internal_error', 'Failed to list users');
  }
}

/**
 * POST /admin/users — create a staff/exhibitor account.
 * Body: { email, group: 'staff'|'exhibitor', password, stationId? }
 */
export async function handleCreateUser(body, claims) {
  if (!isAdmin(claims)) return error(403, 'forbidden', 'Admin group membership required');
  const userPoolId = getUserPoolId();
  if (!userPoolId) return error(500, 'internal_error', 'USER_POOL_ID not configured');

  const email = body && typeof body.email === 'string' ? body.email.trim() : '';
  const group = body && typeof body.group === 'string' ? body.group.trim() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';
  const stationId = body && body.stationId != null ? String(body.stationId).trim() : '';

  if (!email) return missingField('email');
  if (!group) return missingField('group');
  if (!password) return missingField('password');
  if (!MANAGED_GROUPS.includes(group)) {
    return error(400, 'invalid_field', 'group must be staff or exhibitor', 'group');
  }
  if (group === 'exhibitor' && !stationId) {
    return error(400, 'invalid_field', 'stationId is required for exhibitor accounts', 'stationId');
  }
  if (password.length < 8) {
    return error(400, 'invalid_field', 'Password must be at least 8 characters', 'password');
  }

  try {
    const userAttributes = [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
    ];
    if (group === 'exhibitor') {
      userAttributes.push({ Name: 'custom:stationId', Value: stationId });
    }

    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: userAttributes,
      MessageAction: 'SUPPRESS',
    }));

    // Set the chosen password as permanent (no forced change on first login).
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }));

    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: email,
      GroupName: group,
    }));

    return ok({ created: true, email, group, stationId: stationId || null });
  } catch (err) {
    if (err.name === 'UsernameExistsException') {
      return error(409, 'already_exists', 'An account with this email already exists');
    }
    if (err.name === 'InvalidPasswordException') {
      return error(400, 'invalid_field', '密码不符合策略（至少 8 位，含大小写字母和数字）', 'password');
    }
    console.error('Create user error:', err);
    return error(500, 'internal_error', 'Failed to create user');
  }
}

/**
 * POST /admin/users/password — reset an account's password.
 * Body: { email, password }
 */
export async function handleResetUserPassword(body, claims) {
  if (!isAdmin(claims)) return error(403, 'forbidden', 'Admin group membership required');
  const userPoolId = getUserPoolId();
  if (!userPoolId) return error(500, 'internal_error', 'USER_POOL_ID not configured');

  const email = body && typeof body.email === 'string' ? body.email.trim() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!email) return missingField('email');
  if (!password) return missingField('password');
  if (password.length < 8) {
    return error(400, 'invalid_field', 'Password must be at least 8 characters', 'password');
  }

  try {
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }));
    return ok({ reset: true, email });
  } catch (err) {
    if (err.name === 'UserNotFoundException') {
      return error(404, 'not_found', 'Account not found');
    }
    if (err.name === 'InvalidPasswordException') {
      return error(400, 'invalid_field', '密码不符合策略（至少 8 位，含大小写字母和数字）', 'password');
    }
    console.error('Reset password error:', err);
    return error(500, 'internal_error', 'Failed to reset password');
  }
}

/**
 * POST /admin/users/delete — delete a staff/exhibitor account.
 * Body: { email }
 */
export async function handleDeleteUser(body, claims) {
  if (!isAdmin(claims)) return error(403, 'forbidden', 'Admin group membership required');
  const userPoolId = getUserPoolId();
  if (!userPoolId) return error(500, 'internal_error', 'USER_POOL_ID not configured');

  const email = body && typeof body.email === 'string' ? body.email.trim() : '';
  if (!email) return missingField('email');

  try {
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: userPoolId,
      Username: email,
    }));
    return ok({ deleted: true, email });
  } catch (err) {
    if (err.name === 'UserNotFoundException') {
      return error(404, 'not_found', 'Account not found');
    }
    console.error('Delete user error:', err);
    return error(500, 'internal_error', 'Failed to delete user');
  }
}
