// Feature: after-party-lottery, Property 10: Draw selection invariants
//
// This file hosts the property-based tests for lottery DRAW behavior. The
// first property (Property 10, below) covers draw selection invariants:
// every winner is drawn from the pool, the draw never removes participants,
// and an empty pool yields a 400 `no_participants`.
//
// Subsequent properties are appended by later tasks:
//   - Property 11: Draw sequence density / monotonicity (task 5.6)
//   - Property 12: Authorization rejection (task 5.7)
//
// Framework: Vitest + fast-check, using the injectable `setDocClient`
// convention (an in-memory DynamoDB DocumentClient test double) — matching
// the existing nfc-checkin-backend workspace properties.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { handleDraw, handleListParticipants, handleListWinners } from '../../src/lottery-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';

// ---------------------------------------------------------------------------
// Shared helpers (reused by Properties 10-12 — keep additions append-clean).
// ---------------------------------------------------------------------------

/**
 * JWT claims for an authenticated administrator. `handleDraw` and
 * `handleListWinners` require `cognito:groups` to include `admin`.
 */
const ADMIN_CLAIMS = { 'cognito:groups': ['admin'] };

/**
 * Builds a single reserved-nickname item exactly as the registration
 * TransactWriteCommand would persist it. The lottery participant list and the
 * draw both enumerate these via GSI1 (`GSI1PK = 'NICKNAME_LIST'`).
 *
 * @param {string} nickname - Registered nickname (also the GSI1 sort key).
 * @param {string} tagId - The tag bound to this nickname.
 * @returns {object} Item in single-table shape.
 */
function buildReservedItem(nickname, tagId) {
  return {
    PK: `NICKNAME#${nickname}`,
    SK: 'RESERVED',
    GSI1PK: 'NICKNAME_LIST',
    GSI1SK: nickname,
    tagId,
    nickname,
    registeredAt: '2026-06-28T10:00:00.000Z',
  };
}

/**
 * Maps a pool of distinct nicknames to their reserved-nickname seed items,
 * assigning each a deterministic, distinct tagId.
 *
 * @param {Array<string>} nicknames - Distinct participant nicknames.
 * @returns {Array<object>} Reserved-nickname seed items.
 */
function seedParticipants(nicknames) {
  return nicknames.map((nickname, i) => buildReservedItem(nickname, `tag-${i}`));
}

/**
 * Builds an in-memory DynamoDB DocumentClient test double keyed by `PK|SK`.
 * A single store instance is shared by `handleListParticipants` and
 * `handleDraw` so participant reads and draw writes observe the same state.
 *
 * Supports the exact command surface exercised by the draw flow:
 *   - QueryCommand (GSI1)   — enumerate items where `GSI1PK = :gsiPk`
 *   - QueryCommand (base)   — `PK = :pk [AND begins_with(SK, :skPrefix)]`
 *   - UpdateCommand         — atomic `ADD seq :one` on the draw counter,
 *                             returning the incremented `seq` (UPDATED_NEW).
 *   - PutCommand            — persist the winner record.
 *   - GetCommand            — point lookup by `{ PK, SK }`.
 *
 * @param {Array<object>} seedItems - Initial items to load into the store.
 * @returns {{ send: Function, _store: Map<string, object> }}
 */
function createLotteryStore(seedItems = []) {
  const store = new Map();
  const keyOf = (pk, sk) => `${pk}|${sk}`;
  for (const item of seedItems) {
    store.set(keyOf(item.PK, item.SK), { ...item });
  }

  return {
    _store: store,
    send: async (command) => {
      const name = command.constructor.name;
      const input = command.input || {};

      if (name === 'QueryCommand') {
        const values = input.ExpressionAttributeValues || {};
        const items = [];

        // GSI query (e.g. GSI1PK = 'NICKNAME_LIST').
        if (input.IndexName) {
          const pkAttr = `${input.IndexName}PK`;
          const gsiPk = values[':gsiPk'];
          for (const item of store.values()) {
            if (item[pkAttr] === gsiPk) items.push({ ...item });
          }
          return { Items: items };
        }

        // Base-table query: PK [+ optional begins_with(SK, prefix)].
        const pk = values[':pk'];
        const prefix = values[':skPrefix'];
        for (const item of store.values()) {
          if (item.PK !== pk) continue;
          if (prefix !== undefined && !String(item.SK).startsWith(prefix)) continue;
          items.push({ ...item });
        }
        // Honor ScanIndexForward (ascending SK) for the winners query.
        items.sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
        if (input.ScanIndexForward === false) items.reverse();
        return { Items: items };
      }

      if (name === 'UpdateCommand') {
        // Only the atomic `ADD seq :one` on LOTTERY/DRAW_COUNTER is used.
        const { PK, SK } = input.Key || {};
        const k = keyOf(PK, SK);
        const existing = store.get(k) || { PK, SK };
        const values = input.ExpressionAttributeValues || {};
        const increment = typeof values[':one'] === 'number' ? values[':one'] : 0;
        const currentSeq = typeof existing.seq === 'number' ? existing.seq : 0;
        const newSeq = currentSeq + increment;
        store.set(k, { ...existing, seq: newSeq });
        // ReturnValues: 'UPDATED_NEW' returns only the mutated attribute.
        return { Attributes: { seq: newSeq } };
      }

      if (name === 'PutCommand') {
        const item = input.Item;
        store.set(keyOf(item.PK, item.SK), { ...item });
        return {};
      }

      if (name === 'GetCommand') {
        const { PK, SK } = input.Key || {};
        const found = store.get(keyOf(PK, SK));
        return { Item: found ? { ...found } : undefined };
      }

      return {};
    },
  };
}

/**
 * Returns the sorted multiset of nicknames from a participants array, so two
 * participant lists can be compared independent of element order.
 *
 * @param {Array<{ nickname: string }>} participants
 * @returns {Array<string>}
 */
function nicknameMultiset(participants) {
  return participants.map((p) => p.nickname).sort();
}

// A non-empty pool of DISTINCT nicknames (1-20 printable chars, size 1..30).
const poolArb = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 1,
  maxLength: 30,
});

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

describe('Property 10: Draw selection invariants', () => {
  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 5.1, 5.4
  it('every winner nickname is in the pool, and K sequential draws leave the participant multiset unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(poolArb, fc.integer({ min: 1, max: 12 }), async (nicknames, k) => {
        // Fresh shared store seeded with the pool's reserved-nickname items.
        const client = createLotteryStore(seedParticipants(nicknames));
        setDocClient(client);

        const poolSet = new Set(nicknames);

        // Snapshot the participant list BEFORE any draws.
        const beforeRes = await handleListParticipants();
        expect(beforeRes.statusCode).toBe(200);
        const beforeBody = JSON.parse(beforeRes.body);
        expect(beforeBody.count).toBe(nicknames.length);
        const beforeMultiset = nicknameMultiset(beforeBody.participants);

        // Run K sequential draws; each must return a winner drawn from P.
        for (let i = 0; i < k; i++) {
          const res = await handleDraw(ADMIN_CLAIMS);
          expect(res.statusCode).toBe(200);
          const body = JSON.parse(res.body);
          // Winner nickname is a member of the pool (Requirement 5.1).
          expect(poolSet.has(body.nickname)).toBe(true);
        }

        // Snapshot AFTER all draws — the participant multiset is unchanged.
        // Draws never remove (or add) participants (Requirement 5.4).
        const afterRes = await handleListParticipants();
        expect(afterRes.statusCode).toBe(200);
        const afterBody = JSON.parse(afterRes.body);
        expect(afterBody.count).toBe(nicknames.length);
        expect(nicknameMultiset(afterBody.participants)).toEqual(beforeMultiset);
      }),
      { numRuns: 150 }
    );
  });

  // Validates: Requirement 5.3
  it('a draw against an empty participant pool returns 400 no_participants', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (attempts) => {
        // Empty store — no reserved-nickname records exist.
        const client = createLotteryStore([]);
        setDocClient(client);

        // Repeated attempts all fail identically; an empty pool stays empty.
        for (let i = 0; i < attempts; i++) {
          const res = await handleDraw(ADMIN_CLAIMS);
          expect(res.statusCode).toBe(400);
          expect(JSON.parse(res.body).error).toBe('no_participants');
        }
      }),
      { numRuns: 30 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Draw sequence is dense, monotonic, and matches stored records
// ---------------------------------------------------------------------------
//
// After K draws, GET /lottery/winners returns exactly K records, sorted
// ascending by drawSeq, with drawSeq values densely covering [1, 2, ..., K]
// (the atomic counter starts at 1 on a fresh DRAW_COUNTER). Each stored winner
// record must match the corresponding POST /lottery/draw response body
// byte-for-byte across { drawSeq, nickname, tagId, drawnAt }.

describe('Property 11: Draw sequence is dense, monotonic, and matches stored records', () => {
  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 5.2, 5.5, 5.7
  it('K draws yield exactly K winners with drawSeq [1..K] ascending, each matching its draw response body', async () => {
    await fc.assert(
      fc.asyncProperty(poolArb, fc.integer({ min: 1, max: 12 }), async (nicknames, k) => {
        // Fresh shared store seeded with the pool's reserved-nickname items.
        const client = createLotteryStore(seedParticipants(nicknames));
        setDocClient(client);

        // Run K sequential draws, capturing each draw response body.
        const drawBodies = [];
        for (let i = 0; i < k; i++) {
          const res = await handleDraw(ADMIN_CLAIMS);
          expect(res.statusCode).toBe(200);
          drawBodies.push(JSON.parse(res.body));
        }

        // Each draw, in order, must have been assigned a dense, monotonic
        // sequence starting at 1 (the atomic counter's first increment).
        for (let i = 0; i < k; i++) {
          expect(drawBodies[i].drawSeq).toBe(i + 1);
        }

        // GET /lottery/winners returns exactly K winners (Requirement 5.5).
        const winnersRes = await handleListWinners(ADMIN_CLAIMS);
        expect(winnersRes.statusCode).toBe(200);
        const winnersBody = JSON.parse(winnersRes.body);
        expect(winnersBody.count).toBe(k);
        expect(winnersBody.winners.length).toBe(k);

        // drawSeq values are sorted ascending and equal to [1, 2, ..., K]
        // — dense and monotonic (Requirements 5.2, 5.7).
        const seqs = winnersBody.winners.map((w) => w.drawSeq);
        expect(seqs).toEqual(Array.from({ length: k }, (_, i) => i + 1));

        // Each stored winner record matches the corresponding draw response
        // body byte-for-byte across { drawSeq, nickname, tagId, drawnAt }
        // (Requirement 5.2 — the stored result equals what the draw returned).
        for (let i = 0; i < k; i++) {
          expect(winnersBody.winners[i]).toEqual({
            drawSeq: drawBodies[i].drawSeq,
            nickname: drawBodies[i].nickname,
            tagId: drawBodies[i].tagId,
            drawnAt: drawBodies[i].drawnAt,
          });
        }
      }),
      { numRuns: 150 }
    );
  });

  // Validates: Requirement 5.8
  it('GET /lottery/winners with no draws returns an empty list with count zero', async () => {
    await fc.assert(
      fc.asyncProperty(poolArb, async (nicknames) => {
        // A seeded participant pool but ZERO draws executed.
        const client = createLotteryStore(seedParticipants(nicknames));
        setDocClient(client);

        const winnersRes = await handleListWinners(ADMIN_CLAIMS);
        expect(winnersRes.statusCode).toBe(200);
        const winnersBody = JSON.parse(winnersRes.body);
        expect(winnersBody.count).toBe(0);
        expect(winnersBody.winners).toEqual([]);
      }),
      { numRuns: 30 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12 is appended below by task 5.7.
// ---------------------------------------------------------------------------

// Feature: after-party-lottery, Property 12: Authorization rejection
//
// POST /lottery/draw and GET /lottery/winners are admin-only. For any caller
// whose claims lack `cognito:groups`, or whose `cognito:groups` does not
// include the `admin` token, both endpoints SHALL reject with 403 `forbidden`
// and SHALL NOT persist a winner record. (The API Gateway JWT authorizer, not
// the handler, produces 401 for a missing/invalid token — at the handler
// level an absent/empty claims object is indistinguishable from a non-admin
// caller and yields 403 `forbidden`.)

// ---------------------------------------------------------------------------
// Property 12 helpers — non-admin claims generators + a winner-record counter.
// ---------------------------------------------------------------------------

/**
 * Counts persisted draw-winner records in an in-memory lottery store. A winner
 * record is any item with `PK === 'LOTTERY'` and `SK` beginning with
 * `'WINNER#'`. Used to assert that a rejected (non-admin) draw mutates nothing.
 *
 * @param {Map<string, object>} store - The lottery store's backing Map (`_store`).
 * @returns {number} Number of LOTTERY/WINNER# items present.
 */
function countWinnerItems(store) {
  let count = 0;
  for (const item of store.values()) {
    if (item.PK === 'LOTTERY' && String(item.SK).startsWith('WINNER#')) {
      count += 1;
    }
  }
  return count;
}

// A single non-admin group label. Deliberately includes adversarial near-misses
// ('Admin', 'ADMIN', 'administrator', 'admins') that must NOT be treated as the
// case-sensitive `admin` token by the handler's authorization check.
const nonAdminTokenArb = fc.constantFrom(
  'staff',
  'user',
  'guest',
  'viewer',
  'moderator',
  'operator',
  'attendee',
  'Admin',
  'ADMIN',
  'administrator',
  'admins'
);

// Arbitrary claims objects that are NOT admin. Covers the full shape space:
//   - absent claims (null / undefined)
//   - object with no `cognito:groups` key
//   - array form (including empty array)
//   - comma-separated string form ("staff, user")
//   - bracketed string form ("[staff, user]")
//   - single-string form ("staff")
// None of these normalize to a group list containing the `admin` token.
const nonAdminClaimsArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({}),
  fc.record({ sub: fc.string(), iss: fc.string() }), // claims without cognito:groups
  fc.array(nonAdminTokenArb, { minLength: 0, maxLength: 4 }).map((tokens) => ({
    'cognito:groups': tokens, // array form (may be empty)
  })),
  fc.array(nonAdminTokenArb, { minLength: 1, maxLength: 4 }).map((tokens) => ({
    'cognito:groups': tokens.join(', '), // comma-separated string form
  })),
  fc.array(nonAdminTokenArb, { minLength: 1, maxLength: 4 }).map((tokens) => ({
    'cognito:groups': `[${tokens.join(', ')}]`, // bracketed string form
  })),
  nonAdminTokenArb.map((token) => ({ 'cognito:groups': token })) // single-string form
);

describe('Property 12: Authorization rejection', () => {
  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 5.6
  it('non-admin callers get 403 forbidden from draw and winners, and no winner record is persisted', async () => {
    await fc.assert(
      fc.asyncProperty(poolArb, nonAdminClaimsArb, async (nicknames, claims) => {
        // A non-empty participant pool exists — so the only thing standing
        // between the caller and a winner record is the authorization gate.
        const client = createLotteryStore(seedParticipants(nicknames));
        setDocClient(client);

        // No winner records exist before the (rejected) calls.
        expect(countWinnerItems(client._store)).toBe(0);

        // POST /lottery/draw → 403 forbidden for any non-admin caller.
        const drawRes = await handleDraw(claims);
        expect(drawRes.statusCode).toBe(403);
        expect(JSON.parse(drawRes.body).error).toBe('forbidden');

        // GET /lottery/winners → 403 forbidden for any non-admin caller.
        const winnersRes = await handleListWinners(claims);
        expect(winnersRes.statusCode).toBe(403);
        expect(JSON.parse(winnersRes.body).error).toBe('forbidden');

        // The rejected draw must not have persisted any winner record.
        expect(countWinnerItems(client._store)).toBe(0);
      }),
      { numRuns: 200 }
    );
  });

  // Positive control: confirm the authorization gate is not rejecting EVERY
  // caller — a genuine admin draw against the same seeded pool still succeeds
  // and persists exactly one winner record. (Keeps the focus on Property 12 by
  // verifying the 403s above are caused by non-admin claims, not a broken gate.)
  it('admin caller draw succeeds (200) and persists a winner — gate is not rejecting everyone', async () => {
    await fc.assert(
      fc.asyncProperty(poolArb, async (nicknames) => {
        const client = createLotteryStore(seedParticipants(nicknames));
        setDocClient(client);

        expect(countWinnerItems(client._store)).toBe(0);

        const drawRes = await handleDraw(ADMIN_CLAIMS);
        expect(drawRes.statusCode).toBe(200);

        expect(countWinnerItems(client._store)).toBe(1);
      }),
      { numRuns: 50 }
    );
  });
});
