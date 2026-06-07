// Feature: after-party-lottery, Property 2: After-party eligibility derivation
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { handleProgress } from '../../src/progress-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';
import { setClock, resetClock, getAfterPartyTimeGateMs } from '../../src/utils/time.mjs';

/**
 * A TTL far in the future (year ~3000 in Unix epoch seconds) so that every
 * generated check-in record survives `filterExpired()` regardless of the
 * injected clock. This isolates the property under test (after-party
 * eligibility derivation) from TTL expiry behavior.
 */
const FAR_FUTURE_TTL = 32503680000;

/**
 * A fixed clock value used for determinism. Its exact position relative to the
 * After Party time gate is irrelevant to this property: the progress handler
 * always includes `afterPartyEligible` in the response body, regardless of the
 * time gate (only `lotteryEligible`/`lotteryReason`/`nickname` are gated).
 */
const FIXED_TIME = 1700000000000; // 2023-11-14T22:13:20.000Z

/**
 * Builds a hand-rolled mock DynamoDB DocumentClient (the project's established
 * test-double convention via `setDocClient`). The QueryCommand for
 * `TAG#{tagId}` begins-with `CHECKIN#` returns the seeded check-in records;
 * every GetCommand (STAMPRALLY / NICKNAME lookups) returns no item.
 * @param {Array<object>} checkinItems - Seeded check-in records
 */
function createMockClient(checkinItems) {
  return {
    send: async (command) => {
      const commandName = command.constructor.name;
      if (commandName === 'QueryCommand') {
        return { Items: checkinItems };
      }
      if (commandName === 'GetCommand') {
        return { Item: undefined };
      }
      return {};
    },
  };
}

/**
 * Arbitrary for the `afterParty` attribute. Includes the two booleans plus
 * several truthy/falsy non-boolean values and absence (undefined) so the
 * property exercises the handler's strict `=== true` derivation.
 */
const afterPartyFlagArb = fc.constantFrom(true, false, undefined, null, 1, 0, 'true', 'false');

/**
 * Arbitrary for a single seeded check-in record. Provides the fields the
 * progress handler reads (stationId, checkinTime, ttl) and a varying
 * `afterParty` flag. The far-future TTL guarantees survival of filterExpired.
 */
const checkinRecordArb = fc.record({
  stationId: fc.integer({ min: 1, max: 10 }),
  checkinTime: fc
    .integer({ min: 0, max: 4102444800000 })
    .map((ms) => new Date(ms).toISOString()),
  afterParty: afterPartyFlagArb,
  ttl: fc.constant(FAR_FUTURE_TTL),
});

describe('Property 2: After-party eligibility derivation', () => {
  beforeEach(() => {
    setClock(() => FIXED_TIME);
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 1.5, 1.6
  it('afterPartyEligible equals records.some(r => r.afterParty === true)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(checkinRecordArb, { minLength: 0, maxLength: 30 }),
        async (records) => {
          setDocClient(createMockClient(records));

          const res = await handleProgress('tag-prop2');
          const body = JSON.parse(res.body);

          expect(res.statusCode).toBe(200);
          expect(body.afterPartyEligible).toBe(
            records.some((r) => r.afterParty === true)
          );
        }
      ),
      { numRuns: 200 }
    );
  });
});

// Feature: after-party-lottery, Property 3: Lottery eligibility computation

/** Total station count required for completion (mirrors the handler constant). */
const TOTAL_STATIONS_PROP3 = 10;

/**
 * Reference oracle mirroring the four-branch lottery-eligibility specification
 * from design.md §1.3 (Progress Handler Augmentation). Given the current time
 * and the seeded check-in record set, it returns the exact subset of response
 * fields under test: `stationsRemaining` always, and `lotteryEligible` /
 * `lotteryReason` only when the current time is at or after the time gate.
 *
 * The handler counts surviving check-in *records* (not distinct stations) as
 * `totalCheckins`; because every seeded record carries a far-future TTL, all
 * survive `filterExpired`, so `totalCheckins === records.length`.
 *
 * @param {number} currentTime - Injected clock value in Unix epoch ms
 * @param {Array<object>} records - Seeded check-in records
 * @param {number} gate - The After Party time gate in Unix epoch ms
 * @returns {{ stationsRemaining: number, lotteryEligible?: boolean, lotteryReason?: (string|null) }}
 */
function expectedLotteryFields(currentTime, records, gate) {
  const totalCheckins = records.length;
  const completed = totalCheckins === TOTAL_STATIONS_PROP3;
  const afterPartyEligible = records.some((r) => r.afterParty === true);
  const beforeGate = currentTime < gate;
  const stationsRemaining = completed ? 0 : TOTAL_STATIONS_PROP3 - totalCheckins;

  const expected = { stationsRemaining };

  if (!beforeGate) {
    let lotteryEligible = false;
    let lotteryReason = null;
    if (completed && afterPartyEligible) {
      lotteryEligible = true;
    } else if (!completed && !afterPartyEligible) {
      lotteryReason = 'incomplete_stations_and_no_after_party_checkin';
    } else if (!completed) {
      lotteryReason = 'incomplete_stations';
    } else {
      lotteryReason = 'after_party_checkin_required';
    }
    expected.lotteryEligible = lotteryEligible;
    expected.lotteryReason = lotteryReason; // null when eligible
  }

  return expected;
}

describe('Property 3: Lottery eligibility computation', () => {
  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 2.1, 2.2, 2.3, 2.5
  it('lotteryEligible, lotteryReason, and stationsRemaining match the four-branch spec (with omission before the gate)', async () => {
    // The time gate is parsed once and cached by the handler; read the same
    // value here so generated `currentTime`s straddle it consistently.
    const GATE = getAfterPartyTimeGateMs();

    // currentTime spans both sides of the gate, including the boundary (== GATE
    // counts as at/after the gate per the handler's `now() < gate` comparison).
    const currentTimeArb = fc.oneof(
      fc.integer({ min: 0, max: GATE - 1 }), // strictly before the gate
      fc.integer({ min: GATE, max: GATE + 10_000_000_000 }) // at or after the gate
    );

    // Bias record counts so the `completed` (exactly 10) branches are exercised
    // frequently, while still covering 0..12 (including the negative
    // stationsRemaining edge when count exceeds 10).
    const recordCountArb = fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 12 }) },
      { weight: 2, arbitrary: fc.constant(10) }
    );

    // For a chosen count, generate that many afterParty flags, then map each to
    // a full check-in record with a far-future TTL so none are filtered out.
    const recordSetArb = recordCountArb.chain((n) =>
      fc.array(afterPartyFlagArb, { minLength: n, maxLength: n }).map((flags) =>
        flags.map((flag, i) => ({
          stationId: (i % TOTAL_STATIONS_PROP3) + 1,
          checkinTime: new Date(1700000000000 + i * 1000).toISOString(),
          afterParty: flag,
          ttl: FAR_FUTURE_TTL,
        }))
      )
    );

    await fc.assert(
      fc.asyncProperty(currentTimeArb, recordSetArb, async (currentTime, records) => {
        setClock(() => currentTime);
        setDocClient(createMockClient(records));

        const res = await handleProgress('tag-prop3');
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(200);

        const expected = expectedLotteryFields(currentTime, records, GATE);

        // stationsRemaining is always present and must match exactly.
        expect(body.stationsRemaining).toBe(expected.stationsRemaining);

        if (currentTime < GATE) {
          // Before the gate: lottery fields are omitted entirely (Req 2.5).
          expect(body).not.toHaveProperty('lotteryEligible');
          expect(body).not.toHaveProperty('lotteryReason');
        } else {
          // At/after the gate: lotteryEligible always present and exact.
          expect(body.lotteryEligible).toBe(expected.lotteryEligible);

          if (expected.lotteryReason === null) {
            // Eligible (or no reason) → reason field omitted.
            expect(body).not.toHaveProperty('lotteryReason');
          } else {
            expect(body.lotteryReason).toBe(expected.lotteryReason);
          }
        }
      }),
      { numRuns: 300 }
    );
  });
});
