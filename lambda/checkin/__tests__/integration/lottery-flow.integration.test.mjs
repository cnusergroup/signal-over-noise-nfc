// Feature: after-party-lottery — end-to-end lottery flow integration test
//
// Exercises the full backend lottery pipeline against a single in-memory
// DynamoDB DocumentClient test double, wiring the real handlers together:
//
//   register (POST /lottery/nickname)  -> handleNicknameRegister(body)
//   list     (GET  /lottery/participants) -> handleListParticipants()
//   draw     (POST /lottery/draw)       -> handleDraw(ADMIN_CLAIMS)
//   winners  (GET  /lottery/winners)    -> handleListWinners(ADMIN_CLAIMS)
//
// The happy path seeds three lottery-eligible tags (10 distinct station
// check-ins each, one flagged afterParty:true), registers a distinct nickname
// per tag, lists participants (count 3), draws three winners, and lists the
// winners (drawSeq [1,2,3], byte-for-byte equal to the draw response bodies).
//
// Negative paths are covered inline:
//   - registration before the time gate           -> 403 lottery_not_open
//   - duplicate nickname (second eligible tag)     -> 409 nickname_taken
//   - draw against an empty participant pool       -> 400 no_participants
//
// This is a Vitest integration test (not a property test) but lives in the
// lambda/checkin Vitest suite and follows the project's injectable
// `setDocClient` + `setClock` convention — no aws-sdk-client-mock. The store
// below combines the registration TransactWrite double (from
// lottery-nickname.property.test.mjs) with the draw/participants/winners
// command double (from lottery-draw.property.test.mjs) into one client that
// handles every command the lottery flow issues.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleNicknameRegister,
  handleListParticipants,
  handleDraw,
  handleListWinners,
} from '../../src/lottery-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** JWT claims for an authenticated administrator (draw / winners are admin-only). */
const ADMIN_CLAIMS = { 'cognito:groups': ['admin'] };

/** A TTL far in the future (year ~3000 epoch seconds) so seeded check-ins never expire. */
const FAR_FUTURE_TTL = 32503680000;

/** A fixed clock value AFTER the default time gate (2026-06-28T09:00:00Z): the lottery is open. */
const AFTER_GATE_TIME = Date.parse('2026-06-28T10:00:00Z');

/** A fixed clock value BEFORE the default time gate: registration is not yet available. */
const BEFORE_GATE_TIME = Date.parse('2026-06-28T08:00:00Z');

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Builds 10 distinct-station check-in records for a tag, with exactly one
 * record flagged `afterParty: true`, so the tag satisfies lottery eligibility
 * (all 10 stations AND at least one After Party check-in).
 *
 * @param {string} tagId
 * @returns {Array<object>} Seed items in single-table shape.
 */
function buildEligibleCheckins(tagId) {
  return Array.from({ length: 10 }, (_, i) => {
    const stationId = i + 1;
    return {
      PK: `TAG#${tagId}`,
      SK: `CHECKIN#${stationId}`,
      GSI1PK: `STATION#${stationId}`,
      GSI1SK: `CHECKIN#2026-06-28T10:0${i}:00.000Z`,
      tagId,
      stationId,
      checkinTime: `2026-06-28T10:0${i}:00.000Z`,
      // Flag the last station as the After Party check-in.
      afterParty: stationId === 10,
      ttl: FAR_FUTURE_TTL,
    };
  });
}

// ---------------------------------------------------------------------------
// In-memory DynamoDB DocumentClient test double
// ---------------------------------------------------------------------------

/**
 * Builds an in-memory DynamoDB DocumentClient test double keyed by `PK|SK`.
 *
 * Combines the command surfaces of the lottery nickname and draw property
 * tests so a single store can back the entire end-to-end flow:
 *
 *   - QueryCommand (GSI1)  — enumerate items where `GSI1PK = :gsiPk`
 *                            (participant list + draw pool via NICKNAME_LIST).
 *   - QueryCommand (base)  — `PK = :pk [AND begins_with(SK, :skPrefix)]`,
 *                            sorted ascending by SK and honoring
 *                            ScanIndexForward (eligibility + winners queries).
 *   - GetCommand           — point lookup by `{ PK, SK }`.
 *   - TransactWriteCommand — all-or-nothing conditional Puts; honors
 *                            `attribute_not_exists(PK)` and raises a
 *                            `TransactionCanceledException` carrying
 *                            `CancellationReasons` when a condition fails
 *                            (nickname registration).
 *   - UpdateCommand        — atomic `ADD seq :one` on the draw counter,
 *                            returning the incremented `seq` (UPDATED_NEW).
 *   - PutCommand           — persist the winner record.
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
        // Ascending SK order; honor ScanIndexForward (winners chronology).
        items.sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
        if (input.ScanIndexForward === false) items.reverse();
        return { Items: items };
      }

      if (name === 'GetCommand') {
        const { PK, SK } = input.Key || {};
        const found = store.get(keyOf(PK, SK));
        return { Item: found ? { ...found } : undefined };
      }

      if (name === 'TransactWriteCommand') {
        const transactItems = input.TransactItems || [];
        // Evaluate every condition against the current snapshot first.
        const reasons = transactItems.map((ti) => {
          const put = ti.Put;
          if (!put) return { Code: 'None' };
          const { PK, SK } = put.Item;
          const exists = store.has(keyOf(PK, SK));
          if (put.ConditionExpression === 'attribute_not_exists(PK)' && exists) {
            return { Code: 'ConditionalCheckFailed' };
          }
          return { Code: 'None' };
        });

        if (reasons.some((r) => r.Code === 'ConditionalCheckFailed')) {
          const err = new Error('Transaction cancelled');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = reasons;
          throw err;
        }

        // All conditions passed — apply every Put atomically.
        for (const ti of transactItems) {
          const put = ti.Put;
          if (!put) continue;
          store.set(keyOf(put.Item.PK, put.Item.SK), { ...put.Item });
        }
        return {};
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

      return {};
    },
  };
}

// ---------------------------------------------------------------------------
// End-to-end lottery flow
// ---------------------------------------------------------------------------

describe('After Party Lottery — end-to-end integration flow', () => {
  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    setClock(() => AFTER_GATE_TIME);
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 2.1, 3.1, 4.1, 5.1, 5.5
  it('registers three eligible tags, lists 3 participants, draws 3 winners, and lists them with drawSeq [1,2,3]', async () => {
    const tags = ['tag-alpha', 'tag-bravo', 'tag-charlie'];
    const nicknames = ['Alice', 'Bob', 'Carol'];

    // Seed all three eligible tags into one shared store.
    const client = createLotteryStore([
      ...buildEligibleCheckins(tags[0]),
      ...buildEligibleCheckins(tags[1]),
      ...buildEligibleCheckins(tags[2]),
    ]);
    setDocClient(client);

    // 1. Register a distinct nickname for each eligible tag (Requirement 3.1).
    for (let i = 0; i < tags.length; i++) {
      const res = await handleNicknameRegister({ tagId: tags[i], nickname: nicknames[i] });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tagId).toBe(tags[i]);
      expect(body.nickname).toBe(nicknames[i]);
    }

    // 2. GET /lottery/participants → exactly three participants (Requirement 4.1).
    const participantsRes = await handleListParticipants();
    expect(participantsRes.statusCode).toBe(200);
    const participantsBody = JSON.parse(participantsRes.body);
    expect(participantsBody.count).toBe(3);
    expect(participantsBody.participants).toHaveLength(3);

    // The returned nicknames are exactly the registered set (order-independent).
    const returnedNicknames = participantsBody.participants.map((p) => p.nickname).sort();
    expect(returnedNicknames).toEqual([...nicknames].sort());
    // Privacy: tagId is never exposed by the public participants endpoint.
    for (const p of participantsBody.participants) {
      expect(p).not.toHaveProperty('tagId');
    }

    const registeredSet = new Set(nicknames);

    // 3. POST /lottery/draw three times — each winner is in the registered set
    //    and receives a dense, monotonic sequence number (Requirements 5.1, 5.2).
    const drawBodies = [];
    for (let i = 0; i < 3; i++) {
      const drawRes = await handleDraw(ADMIN_CLAIMS);
      expect(drawRes.statusCode).toBe(200);
      const drawBody = JSON.parse(drawRes.body);
      expect(registeredSet.has(drawBody.nickname)).toBe(true);
      expect(drawBody.drawSeq).toBe(i + 1);
      // The winner's tagId resolves to the tag that registered that nickname.
      expect(tags[nicknames.indexOf(drawBody.nickname)]).toBe(drawBody.tagId);
      drawBodies.push(drawBody);
    }

    // 4. GET /lottery/winners → three items, chronological drawSeq [1,2,3],
    //    each byte-for-byte equal to its corresponding draw response body
    //    (Requirement 5.5).
    const winnersRes = await handleListWinners(ADMIN_CLAIMS);
    expect(winnersRes.statusCode).toBe(200);
    const winnersBody = JSON.parse(winnersRes.body);
    expect(winnersBody.count).toBe(3);
    expect(winnersBody.winners).toHaveLength(3);
    expect(winnersBody.winners.map((w) => w.drawSeq)).toEqual([1, 2, 3]);

    for (let i = 0; i < 3; i++) {
      expect(winnersBody.winners[i]).toEqual({
        drawSeq: drawBodies[i].drawSeq,
        nickname: drawBodies[i].nickname,
        tagId: drawBodies[i].tagId,
        drawnAt: drawBodies[i].drawnAt,
      });
    }
  });

  // Negative path 1 — Requirement 3.6: registration before the time gate.
  it('rejects nickname registration before the time gate with 403 lottery_not_open', async () => {
    setClock(() => BEFORE_GATE_TIME);

    const tagId = 'tag-early';
    const client = createLotteryStore(buildEligibleCheckins(tagId));
    setDocClient(client);

    const res = await handleNicknameRegister({ tagId, nickname: 'EarlyBird' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('lottery_not_open');

    // No nickname binding or reservation was written.
    expect(client._store.has(`TAG#${tagId}|NICKNAME`)).toBe(false);
    expect(client._store.has('NICKNAME#EarlyBird|RESERVED')).toBe(false);
  });

  // Negative path 2 — Requirement 3.3: a second eligible tag claiming a
  // nickname already registered by another tag is rejected.
  it('rejects a duplicate nickname from a second eligible tag with 409 nickname_taken', async () => {
    const tagOne = 'tag-first';
    const tagTwo = 'tag-second';
    const client = createLotteryStore([
      ...buildEligibleCheckins(tagOne),
      ...buildEligibleCheckins(tagTwo),
    ]);
    setDocClient(client);

    // First tag claims the nickname — succeeds.
    const firstRes = await handleNicknameRegister({ tagId: tagOne, nickname: 'Duplicate' });
    expect(firstRes.statusCode).toBe(200);

    // Second, distinct eligible tag tries the same nickname — conflict.
    const secondRes = await handleNicknameRegister({ tagId: tagTwo, nickname: 'Duplicate' });
    expect(secondRes.statusCode).toBe(409);
    expect(JSON.parse(secondRes.body).error).toBe('nickname_taken');

    // The second tag never acquired its own nickname binding.
    expect(client._store.has(`TAG#${tagTwo}|NICKNAME`)).toBe(false);
  });

  // Negative path 3 — Requirement 5.3: a draw against an empty pool.
  it('rejects a draw with no participants with 400 no_participants', async () => {
    const client = createLotteryStore([]);
    setDocClient(client);

    const res = await handleDraw(ADMIN_CLAIMS);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('no_participants');

    // No winner record was persisted.
    const hasWinner = [...client._store.values()].some(
      (item) => item.PK === 'LOTTERY' && String(item.SK).startsWith('WINNER#')
    );
    expect(hasWinner).toBe(false);
  });
});
