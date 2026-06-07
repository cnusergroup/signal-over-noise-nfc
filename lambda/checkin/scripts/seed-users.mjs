#!/usr/bin/env node
/**
 * Seed user accounts into Cognito User Pool.
 * Usage: node scripts/seed-users.mjs ./seed-users.json
 */

import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { readFileSync } from 'node:fs';

const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: node scripts/seed-users.mjs <config.json>');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const client = new CognitoIdentityProviderClient({});
const userPoolId = config.userPoolId || process.env.USER_POOL_ID;

if (!userPoolId) {
  console.error('Error: userPoolId required in config or USER_POOL_ID env var');
  process.exit(1);
}

const summary = { created: 0, skipped: 0, errors: [] };

for (const user of config.users) {
  try {
    const attrs = [
      { Name: 'email', Value: user.email },
      { Name: 'email_verified', Value: 'true' },
    ];
    if (user.attributes) {
      for (const [key, value] of Object.entries(user.attributes)) {
        attrs.push({ Name: key, Value: String(value) });
      }
    }

    await client.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: user.email,
      UserAttributes: attrs,
      MessageAction: 'SUPPRESS',
    }));

    // Set temporary password
    if (user.password) {
      await client.send(new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: user.email,
        Password: user.password,
        Permanent: false,
      }));
    }

    // Add to group
    if (user.group) {
      await client.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: user.email,
        GroupName: user.group,
      }));
    }

    summary.created++;
    console.log(`✓ Created: ${user.email} → ${user.group || 'no group'}`);
  } catch (err) {
    if (err.name === 'UsernameExistsException') {
      summary.skipped++;
      console.warn(`⚠ Skipped (exists): ${user.email}`);
    } else {
      summary.errors.push({ email: user.email, error: err.message });
      console.error(`✗ Error: ${user.email} — ${err.message}`);
    }
  }
}

console.log(`\nSummary: ${summary.created} created, ${summary.skipped} skipped, ${summary.errors.length} errors`);
