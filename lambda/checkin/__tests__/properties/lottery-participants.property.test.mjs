// Feature: after-party-lottery, Property 9: Participant list shape
//
// `handleListParticipants` (GET /lottery/participants) enumerates every
// reserved-nickname record via GSI1 (`GSI1PK = 'NICKNAME_LIST'`) and projects
// each to `{ nickname }`, returning `ok({ count, participants })`.
//
// Property 9 asserts the response faithfully reflects the registered set R:
//   - `count === |R|`
//   - `participants.length === |R|`
//   - the multiset of returned nicknames equals the registered multiset
//   - the empty registration set yields `{ count: 0, participants: [] }`
//
// Framework: Vitest + fast-check, using the project's injectable `setDocClient`
// convention (an in-memory DocumentClient test double — NOT aws-sdk-client-mock).
//
// Validates: Requirements 4.1, 4.2, 4.4

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { handleListParticipants } from '../../src/lottery-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';

/**
 * Builds an in-memory DynamoDB DocumentClient test double that serves the
 * single command exercised by `handleListParticipants`: a GSI1 `QueryCommand`
 * for `GSI1PK = 'NICKNAME_LIST'`.
 *
 * The double keys off the query's `IndexName` (and asserts the GSI1 partition
 * key the handler binds) and returns the seeded reserved-nickname items. Any
 * other command resolves to an empty result so an unexpected access surfaces
 * as a failing assertion rather than silently passing.
 *
 * @param {Array<object>} reservedItems - Seeded `NICKNAME#{n}/RESERVED` records.
 * @returns {{ send: Function, _store: Array<object> }}
 */
function createInMemoryClient(reservedItems = []) {
  return {
    _store: reservedItems,
    send: async (command) => {
      const name = command.constructor.name;
      const input = command.input || {};

      if (name === 'QueryCommand') {
        // The participants list is served from GSI1 with GSI1PK = NICKNAME_LIST.
        const values = input.ExpressionAttributeValues || {};
        if (input.IndexName === 'GSI1' && values[':gsiPk'] === 'NICKNAME_LIST') {
          // Return defensive copies so the handler cannot mutate the store.
          return { Items: reservedItems.map((item) => ({ ...item })) };
        }
        return { Items: [] };
      }

      return {};
    },
  };
}

/**
 * Builds a reserved-nickname item in the exact single-table shape produced by
 * a successful nickname registration (see design.md — Nickname uniqueness
 * record). A deterministic `tagId` is bound so each registration is distinct.
 *
 * @param {string} nickname
 * @param {number} i - Index used to synthesize a unique bound tagId.
 * @returns {object}
 */
function buildReservedItem(nickname, i) {
  return {
    PK: `NICKNAME#${nickname}`,
    SK: 'RESERVED',
    GSI1PK: 'NICKNAME_LIST',
    GSI1SK: nickname,
    nickname,
    tagId: `tag-${i}`,
    registeredAt: '2026-06-28T10:00:00.000Z',
  };
}

/**
 * Computes a multiset (value -> count) over an array of strings, so the
 * "multiset of returned nicknames equals the registered multiset" assertion is
 * precise rather than relying on set semantics alone.
 *
 * @param {Array<string>} arr
 * @returns {Map<string, number>}
 */
function toMultiset(arr) {
  const m = new Map();
  for (const v of arr) {
    m.set(v, (m.get(v) || 0) + 1);
  }
  return m;
}

/**
 * Asserts two string multisets are equal (same keys with same counts).
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 */
function expectMultisetsEqual(a, b) {
  expect(a.size).toBe(b.size);
  for (const [value, count] of a) {
    expect(b.get(value)).toBe(count);
  }
}

// A nickname generator: 1-20 character non-empty strings. Nicknames are unique
// by design, so the registered set R is modeled as a SET of DISTINCT nicknames
// via fc.uniqueArray below; the multiset assertion then reduces to set equality
// but is still verified precisely via per-value counts.
const nicknameArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length >= 1);

// A registered set R of distinct nicknames, size 0..200.
const registeredSetArb = fc.uniqueArray(nicknameArb, { minLength: 0, maxLength: 200 });

describe('Property 9: Participant list shape', () => {
  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 4.1, 4.2, 4.4
  it('response count and participants reflect the registered nickname multiset', async () => {
    await fc.assert(
      fc.asyncProperty(registeredSetArb, async (nicknames) => {
        const reservedItems = nicknames.map((n, i) => buildReservedItem(n, i));
        setDocClient(createInMemoryClient(reservedItems));

        const res = await handleListParticipants();
        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        const N = nicknames.length;

        // Req 4.1: count is an integer equal to |R|.
        expect(body.count).toBe(N);
        // Req 4.1/4.2: one participant entry per registered nickname.
        expect(Array.isArray(body.participants)).toBe(true);
        expect(body.participants.length).toBe(N);

        // Each entry exposes only the nickname (tagId stripped for privacy).
        for (const p of body.participants) {
          expect(Object.keys(p)).toEqual(['nickname']);
        }

        // The multiset of returned nicknames equals the registered multiset.
        const returned = body.participants.map((p) => p.nickname);
        expectMultisetsEqual(toMultiset(returned), toMultiset(nicknames));
      }),
      { numRuns: 200 }
    );
  });

  // Validates: Requirement 4.4 — explicit empty case.
  it('returns { count: 0, participants: [] } when no nicknames are registered', async () => {
    setDocClient(createInMemoryClient([]));

    const res = await handleListParticipants();
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.participants).toEqual([]);
  });
});
