// Feature: after-party-lottery, Property 4: Nickname format validator
//
// This file hosts the property-based tests for lottery nickname behavior.
// Property 4 (below) covers the pure format validator `validateNickname`.
// Subsequent properties are appended by later tasks:
//   - Property 5: Nickname registration round-trip (task 4.4)
//   - Property 6: Nickname uniqueness, case-sensitive (task 4.5)
//   - Property 7: Ineligible registration rejection (task 4.6)
//   - Property 8: Tag-level registration idempotence (task 4.7)
//
// Framework: Vitest + fast-check (matching the existing nfc-checkin-backend
// workspace conventions).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { validateNickname } from '../../src/validator.mjs';
import { handleNicknameRegister } from '../../src/lottery-handler.mjs';
import { handleProgress } from '../../src/progress-handler.mjs';
import { setDocClient } from '../../src/utils/dynamo.mjs';
import { setClock, resetClock } from '../../src/utils/time.mjs';

/**
 * Reference oracle for nickname acceptance.
 *
 * `validateNickname(s).ok === true` iff ALL of the following hold:
 *   - `s` is a string
 *   - `s.length` (UTF-16 code units) is in the inclusive range 1..20
 *   - `s` has no leading or trailing whitespace (`s === s.replace(/^\s+|\s+$/g, '')`)
 *   - `s` contains no Unicode control character (general category `Cc`)
 *
 * @param {*} s
 * @returns {boolean}
 */
function oracleAccepts(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.replace(/^\s+|\s+$/g, '');
  return (
    s.length >= 1 &&
    s.length <= 20 &&
    s === trimmed &&
    !/\p{Cc}/u.test(s)
  );
}

// A non-whitespace, non-control "printable" character generator that mixes
// ASCII, CJK, emoji (surrogate pairs), and combining-mark sequences so the
// "accept" branch is exercised across the full intended input space.
const printableCharArb = fc.oneof(
  // ASCII letters / digits / punctuation (no whitespace, no control)
  fc.constantFrom(
    'a', 'Z', 'm', '7', '0', '#', '!', '~', '-', '_', '.', '@', '$', '?'
  ),
  // CJK ideographs (U+4E00..U+9FFF), single code unit each
  fc.integer({ min: 0x4e00, max: 0x9fff }).map((c) => String.fromCodePoint(c)),
  // Emoji (astral plane -> surrogate pairs, length 2 each)
  fc.constantFrom('😀', '🎉', '🚀', '🥳', '🔥', '🌟', '🎲'),
  // Combining-mark sequences (base + combining accent)
  fc.constantFrom('é', 'ñ', 'ü', 'a\u0301', 'e\u0302', 'o\u0303', 'n\u0303')
);

// Whitespace characters that are NOT control characters (Zs / space-likes),
// used to isolate the leading/trailing-whitespace rejection branch.
const nonControlWhitespaceArb = fc.constantFrom(' ', '\u3000', '  ');

// Unicode control characters (general category Cc), including some that are
// also whitespace (\t, \n, \r) and some that are not (\u0000, \u001b, \u007f).
const controlCharArb = fc.constantFrom(
  '\u0000', '\u0007', '\t', '\n', '\r', '\u001b', '\u007f', '\u0085', '\u009f'
);

describe('Property 4: Nickname format validator', () => {
  // Validates: Requirements 3.1, 3.4, 10.1
  it('accepts iff length 1-20, no edge whitespace, and no control chars (oracle agreement over mixed inputs)', () => {
    // Mixed arbitrary spanning every branch: printable, whitespace, control,
    // and a length range that straddles the 20-code-unit boundary.
    const mixedCharArb = fc.oneof(
      printableCharArb,
      nonControlWhitespaceArb,
      controlCharArb
    );
    const mixedStringArb = fc
      .array(mixedCharArb, { minLength: 0, maxLength: 25 })
      .map((chars) => chars.join(''));

    fc.assert(
      fc.property(mixedStringArb, (s) => {
        expect(validateNickname(s).ok).toBe(oracleAccepts(s));
      })
    );
  });

  it('agrees with the oracle over fc.string() and fc.fullUnicodeString()', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.fullUnicodeString({ maxLength: 30 })),
        (s) => {
          expect(validateNickname(s).ok).toBe(oracleAccepts(s));
        }
      )
    );
  });

  it('accepts valid nicknames (length 1-20, no edge whitespace, printable incl. CJK/emoji/combining marks)', () => {
    const validNicknameArb = fc
      .array(printableCharArb, { minLength: 1, maxLength: 20 })
      .map((chars) => chars.join(''))
      // Keep only those within the UTF-16 length bound (emoji count as 2).
      .filter((s) => s.length >= 1 && s.length <= 20);

    fc.assert(
      fc.property(validNicknameArb, (s) => {
        // Sanity: these are constructed to satisfy the oracle.
        expect(oracleAccepts(s)).toBe(true);
        expect(validateNickname(s)).toEqual({ ok: true });
      })
    );
  });

  it('rejects strings containing control characters', () => {
    const withControlArb = fc
      .tuple(
        fc.array(printableCharArb, { minLength: 0, maxLength: 10 }),
        controlCharArb,
        fc.array(printableCharArb, { minLength: 0, maxLength: 10 })
      )
      .map(([before, ctrl, after]) => before.join('') + ctrl + after.join(''));

    fc.assert(
      fc.property(withControlArb, (s) => {
        expect(oracleAccepts(s)).toBe(false);
        const result = validateNickname(s);
        expect(result.ok).toBe(false);
        expect(result.code).toBe('invalid_field');
      })
    );
  });

  it('rejects strings longer than 20 code units', () => {
    // 'a' repeated 21..40 times: no whitespace, no control, length > 20.
    const tooLongArb = fc
      .integer({ min: 21, max: 40 })
      .map((n) => 'a'.repeat(n));

    fc.assert(
      fc.property(tooLongArb, (s) => {
        expect(s.length).toBeGreaterThan(20);
        expect(oracleAccepts(s)).toBe(false);
        const result = validateNickname(s);
        expect(result.ok).toBe(false);
        expect(result.code).toBe('invalid_field');
      })
    );
  });

  it('rejects strings with leading or trailing whitespace', () => {
    const coreArb = fc
      .array(printableCharArb, { minLength: 1, maxLength: 10 })
      .map((chars) => chars.join(''));

    const paddedArb = fc
      .tuple(
        fc.option(nonControlWhitespaceArb, { nil: '' }),
        coreArb,
        fc.option(nonControlWhitespaceArb, { nil: '' })
      )
      // Ensure at least one side actually has padding whitespace.
      .filter(([lead, , trail]) => lead !== '' || trail !== '')
      .map(([lead, core, trail]) => lead + core + trail);

    fc.assert(
      fc.property(paddedArb, (s) => {
        expect(s).not.toBe(s.replace(/^\s+|\s+$/g, ''));
        expect(oracleAccepts(s)).toBe(false);
        const result = validateNickname(s);
        expect(result.ok).toBe(false);
        expect(result.code).toBe('invalid_field');
      })
    );
  });

  it('rejects empty and whitespace-only strings', () => {
    const emptyOrBlankArb = fc.oneof(
      fc.constant(''),
      fc
        .array(nonControlWhitespaceArb, { minLength: 1, maxLength: 10 })
        .map((chars) => chars.join(''))
    );

    fc.assert(
      fc.property(emptyOrBlankArb, (s) => {
        expect(oracleAccepts(s)).toBe(false);
        const result = validateNickname(s);
        expect(result.ok).toBe(false);
        expect(result.code).toBe('invalid_field');
      })
    );
  });

  it('rejects missing / non-string values with code missing_field', () => {
    const nonStringArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.integer(),
      fc.boolean(),
      fc.object(),
      fc.array(fc.anything())
    );

    fc.assert(
      fc.property(nonStringArb, (v) => {
        expect(oracleAccepts(v)).toBe(false);
        const result = validateNickname(v);
        expect(result.ok).toBe(false);
        expect(result.code).toBe('missing_field');
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Properties 6-8 are appended below by tasks 4.5 - 4.7.
// ---------------------------------------------------------------------------

// Feature: after-party-lottery, Property 5: Nickname registration round-trip
//
// For any eligible tag and any valid nickname, a successful
// `POST /lottery/nickname` (handleNicknameRegister) followed by a
// `GET /checkin/{tagId}` (handleProgress) returns the SAME nickname value.
//
// The handlers share a single in-memory DynamoDB store (below) that simulates
// the two-item TransactWriteCommand performed during registration
// (`TAG#{tagId}/NICKNAME` and `NICKNAME#{nickname}/RESERVED`) so the subsequent
// GetCommand issued by the progress handler resolves the registered nickname.
//
// Validates: Requirements 3.1, 3.8

/**
 * A TTL far in the future (year ~3000 in Unix epoch seconds) so every seeded
 * check-in survives `filterExpired()` regardless of the injected clock.
 */
const FAR_FUTURE_TTL = 32503680000;

/**
 * A fixed clock value AFTER the default After Party time gate
 * (2026-06-28T09:00:00Z) so the lottery is open and the progress handler
 * attaches lottery fields (including the nickname) to its response.
 */
const AFTER_GATE_TIME = Date.parse('2026-06-28T10:00:00Z');

/**
 * Builds an in-memory DynamoDB DocumentClient test double keyed by `PK|SK`.
 *
 * Supports the exact command surface exercised by the round-trip:
 *   - QueryCommand     — base-table `PK = :pk [AND begins_with(SK, :skPrefix)]`
 *   - GetCommand       — point lookup by `{ PK, SK }`
 *   - TransactWriteCommand — all-or-nothing conditional Puts; honors
 *     `attribute_not_exists(PK)` and raises a `TransactionCanceledException`
 *     with `CancellationReasons` (mirroring the AWS SDK) when a condition fails.
 *
 * @param {Array<object>} seedItems - Initial items to load into the store.
 * @returns {{ send: Function, _store: Map<string, object> }}
 */
function createInMemoryClient(seedItems = []) {
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
        const pk = values[':pk'];
        const prefix = values[':skPrefix'];
        const items = [];
        for (const item of store.values()) {
          if (item.PK !== pk) continue;
          if (prefix !== undefined && !String(item.SK).startsWith(prefix)) continue;
          items.push({ ...item });
        }
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

      return {};
    },
  };
}

/**
 * Builds 10 distinct station check-in records for a tag, with exactly one
 * record flagged `afterParty: true`, so the tag satisfies lottery eligibility.
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

// Valid-nickname arbitrary: 1-20 UTF-16 code units, no leading/trailing
// whitespace, no control characters — reuses the printable char generator
// defined for Property 4 above.
const validNicknameArb = fc
  .array(printableCharArb, { minLength: 1, maxLength: 20 })
  .map((chars) => chars.join(''))
  .filter((s) => s.length >= 1 && s.length <= 20 && oracleAccepts(s));

describe('Property 5: Nickname registration round-trip', () => {
  beforeEach(() => {
    setClock(() => AFTER_GATE_TIME);
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 3.1, 3.8
  it('GET /checkin/{tagId} returns the nickname previously registered via POST /lottery/nickname', async () => {
    await fc.assert(
      fc.asyncProperty(validNicknameArb, async (nickname) => {
        const tagId = 'tag-prop5';
        // Fresh store per run, seeded with an eligible set of 10 check-ins.
        setDocClient(createInMemoryClient(buildEligibleCheckins(tagId)));

        // 1. Register the nickname — must succeed for an eligible tag.
        const registerRes = await handleNicknameRegister({ tagId, nickname });
        expect(registerRes.statusCode).toBe(200);
        const registerBody = JSON.parse(registerRes.body);
        expect(registerBody.nickname).toBe(nickname);

        // 2. Read progress back — the nickname must round-trip unchanged.
        const progressRes = await handleProgress(tagId);
        expect(progressRes.statusCode).toBe(200);
        const progressBody = JSON.parse(progressRes.body);
        expect(progressBody.nickname).toBe(nickname);
      }),
      { numRuns: 200 }
    );
  });
});

// Feature: after-party-lottery, Property 6: Nickname uniqueness (case-sensitive)
//
// Two sub-properties cover Requirements 3.2 and 3.3:
//
//  (a) Cross-tag conflict: for any pair of DISTINCT eligible tags (t1, t2) and
//      any valid nickname `n`, registering (t1, n) returns 200 while a
//      subsequent registration of (t2, n) returns 409 `nickname_taken`. The
//      second registration succeeds on its own TAG#{t2}/NICKNAME item but fails
//      the NICKNAME#{n}/RESERVED condition (CancellationReasons[1]).
//
//  (b) Case sensitivity: for any case-different pair (n1, n2) (e.g. `alice` vs
//      `ALICE`), each registered against a distinct eligible tag, BOTH return
//      200 — uniqueness is case-sensitive, so NICKNAME#{n1} != NICKNAME#{n2}.
//
// Validates: Requirements 3.2, 3.3

// Distinct-tag arbitrary: alphanumeric-ish suffixes prefixed with `tag-`.
const tagIdArb = fc.hexaString({ minLength: 4, maxLength: 12 }).map((s) => `tag-${s}`);

// A pair of DISTINCT eligible tag ids.
const distinctTagPairArb = fc
  .tuple(tagIdArb, tagIdArb)
  .filter(([a, b]) => a !== b);

// ASCII letters [a-zA-Z] — the only characters whose case conversion both
// changes the string AND preserves UTF-16 length, keeping each variant valid.
const asciiLetterArb = fc
  .integer({ min: 0, max: 51 })
  .map((i) => (i < 26 ? String.fromCharCode(97 + i) : String.fromCharCode(65 + (i - 26))));

// A pair of case-different nicknames (lower vs upper) derived from the same
// base letters. `filter` enforces the task's "ensure they actually differ"
// guard (skip inputs where uppercasing equals lowercasing).
const caseVariantPairArb = fc
  .array(asciiLetterArb, { minLength: 1, maxLength: 20 })
  .map((chars) => chars.join(''))
  .map((s) => [s.toLowerCase(), s.toUpperCase()])
  .filter(([lower, upper]) => lower !== upper);

describe('Property 6: Nickname uniqueness (case-sensitive)', () => {
  beforeEach(() => {
    setClock(() => AFTER_GATE_TIME);
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 3.2, 3.3
  it('a second tag registering an already-taken nickname is rejected with 409 nickname_taken', async () => {
    await fc.assert(
      fc.asyncProperty(distinctTagPairArb, validNicknameArb, async ([t1, t2], nickname) => {
        // Fresh store seeded with eligible check-ins for BOTH tags.
        setDocClient(
          createInMemoryClient([
            ...buildEligibleCheckins(t1),
            ...buildEligibleCheckins(t2),
          ])
        );

        // First tag claims the nickname — succeeds.
        const firstRes = await handleNicknameRegister({ tagId: t1, nickname });
        expect(firstRes.statusCode).toBe(200);
        expect(JSON.parse(firstRes.body).nickname).toBe(nickname);

        // Second, distinct tag tries the same nickname — conflict.
        const secondRes = await handleNicknameRegister({ tagId: t2, nickname });
        expect(secondRes.statusCode).toBe(409);
        expect(JSON.parse(secondRes.body).error).toBe('nickname_taken');
      }),
      { numRuns: 100 }
    );
  });

  // Validates: Requirements 3.2, 3.3
  it('case-different nicknames are distinct: both registrations succeed with 200', async () => {
    await fc.assert(
      fc.asyncProperty(caseVariantPairArb, async ([n1, n2]) => {
        // Distinct nicknames that differ only by case.
        expect(n1).not.toBe(n2);
        // Sanity: both variants are valid nicknames.
        expect(oracleAccepts(n1)).toBe(true);
        expect(oracleAccepts(n2)).toBe(true);

        const tagA = 'tag-case-a';
        const tagB = 'tag-case-b';
        setDocClient(
          createInMemoryClient([
            ...buildEligibleCheckins(tagA),
            ...buildEligibleCheckins(tagB),
          ])
        );

        // Register the lowercase variant against tag A — succeeds.
        const resA = await handleNicknameRegister({ tagId: tagA, nickname: n1 });
        expect(resA.statusCode).toBe(200);
        expect(JSON.parse(resA.body).nickname).toBe(n1);

        // Register the uppercase variant against tag B — also succeeds because
        // uniqueness is case-sensitive (NICKNAME#{n1} != NICKNAME#{n2}).
        const resB = await handleNicknameRegister({ tagId: tagB, nickname: n2 });
        expect(resB.statusCode).toBe(200);
        expect(JSON.parse(resB.body).nickname).toBe(n2);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: after-party-lottery, Property 7: Ineligible registration rejection
//
// `handleNicknameRegister` evaluates two independent gates before ever
// attempting the uniqueness TransactWriteCommand:
//
//   1. Time gate   — `now() < getAfterPartyTimeGateMs()` → 403 lottery_not_open
//   2. Eligibility — fewer than 10 distinct station check-ins OR no check-in
//                    flagged `afterParty === true`        → 403 not_eligible
//
// A registration is ELIGIBLE only when ALL of the following hold:
//   - the clock is at/after the gate            (`!beforeGate`)
//   - the tag has 10 distinct station check-ins (`distinctStationCount === 10`)
//   - at least one of those is an After Party    (`hasAfterPartyCheckin`)
//
// This property enumerates the (beforeGate, distinctStationCount,
// hasAfterPartyCheckin) space, drops the single eligible combination, and
// asserts every remaining (ineligible) combination is rejected with 403 and
// leaves the store free of any NICKNAME binding / reservation item.
//
// Validates: Requirements 3.5, 3.6

/**
 * A fixed clock value BEFORE the default After Party time gate
 * (2026-06-28T09:00:00Z). Used for the `beforeGate === true` branch so the
 * time-gate check rejects with 403 `lottery_not_open` (Requirement 3.6).
 */
const BEFORE_GATE_TIME = Date.parse('2026-06-28T08:00:00Z');

/**
 * Builds `distinctStationCount` distinct-station check-in records for a tag.
 *
 * When `hasAfterPartyCheckin` is true AND at least one record is produced, the
 * last seeded record is flagged `afterParty: true`; otherwise every record is
 * `afterParty: false`. This lets the generated combination directly drive the
 * handler's eligibility predicate without disturbing `buildEligibleCheckins`.
 *
 * @param {string} tagId
 * @param {number} distinctStationCount - 0..10 distinct station check-ins.
 * @param {boolean} hasAfterPartyCheckin - Whether one record is After Party.
 * @returns {Array<object>} Seed items in single-table shape.
 */
function buildCheckins(tagId, distinctStationCount, hasAfterPartyCheckin) {
  return Array.from({ length: distinctStationCount }, (_, i) => {
    const stationId = i + 1;
    return {
      PK: `TAG#${tagId}`,
      SK: `CHECKIN#${stationId}`,
      GSI1PK: `STATION#${stationId}`,
      GSI1SK: `CHECKIN#2026-06-28T10:0${i}:00.000Z`,
      tagId,
      stationId,
      checkinTime: `2026-06-28T10:0${i}:00.000Z`,
      // Flag the last seeded record as the After Party check-in when requested.
      afterParty: hasAfterPartyCheckin && stationId === distinctStationCount,
      ttl: FAR_FUTURE_TTL,
    };
  });
}

/**
 * Counts items in the in-memory store that represent a nickname binding
 * (`SK === 'NICKNAME'`) or a global uniqueness reservation
 * (`PK` beginning with `NICKNAME#`). Used to assert a rejected registration
 * writes ZERO nickname items.
 *
 * @param {Map<string, object>} store
 * @returns {number}
 */
function countNicknameItems(store) {
  let count = 0;
  for (const item of store.values()) {
    if (item.SK === 'NICKNAME' || String(item.PK).startsWith('NICKNAME#')) {
      count += 1;
    }
  }
  return count;
}

// Arbitrary over the eligibility input space, KEEPING ONLY ineligible combos.
// The sole eligible combination — open gate, all 10 stations, and an After
// Party check-in — is filtered out so every generated case must be rejected.
const ineligibleComboArb = fc
  .record({
    beforeGate: fc.boolean(),
    distinctStationCount: fc.integer({ min: 0, max: 10 }),
    hasAfterPartyCheckin: fc.boolean(),
  })
  .filter(
    ({ beforeGate, distinctStationCount, hasAfterPartyCheckin }) =>
      !(!beforeGate && distinctStationCount === 10 && hasAfterPartyCheckin)
  );

describe('Property 7: Ineligible registration rejection', () => {
  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 3.5, 3.6
  it('rejects every ineligible (beforeGate, stations, afterParty) combo with 403 and writes no NICKNAME items', async () => {
    await fc.assert(
      fc.asyncProperty(ineligibleComboArb, validNicknameArb, async (combo, nickname) => {
        const { beforeGate, distinctStationCount, hasAfterPartyCheckin } = combo;

        // Place the clock before/after the gate per the generated combo.
        setClock(() => (beforeGate ? BEFORE_GATE_TIME : AFTER_GATE_TIME));

        const tagId = 'tag-prop7';
        // Fresh store seeded ONLY with the (ineligible) check-in set — no
        // pre-existing nickname items.
        const client = createInMemoryClient(
          buildCheckins(tagId, distinctStationCount, hasAfterPartyCheckin)
        );
        setDocClient(client);

        const beforeCount = countNicknameItems(client._store);

        // Attempt registration with an otherwise-valid nickname.
        const res = await handleNicknameRegister({ tagId, nickname });

        // The request must be rejected with 403 (lottery_not_open OR
        // not_eligible depending on which gate failed).
        expect(res.statusCode).toBe(403);

        // No NICKNAME binding or reservation may have been written.
        const afterCount = countNicknameItems(client._store);
        expect(afterCount - beforeCount).toBe(0);
      }),
      { numRuns: 200 }
    );
  });
});

// Feature: after-party-lottery, Property 8: Tag-level registration idempotence
//
// A tag may register exactly ONE nickname. Once `TAG#{tagId}/NICKNAME` exists,
// any further `POST /lottery/nickname` for the same tag fails the first
// conditional Put (`attribute_not_exists(PK)`), surfacing as
// `CancellationReasons[0].Code === 'ConditionalCheckFailed'` and a
// 409 `already_registered` response — EVEN WHEN the second nickname is a
// brand-new, never-used value (so the NICKNAME#{n2}/RESERVED condition would
// otherwise have passed). The originally persisted binding is never mutated.
//
// For any eligible tag and any pair of valid nicknames (n1, n2):
//   1. register(n1) -> 200, body.nickname === n1
//   2. register(n2) -> 409, body.error === 'already_registered'
//   3. the persisted nickname for the tag remains n1 (verified both directly
//      in the store and via GET /checkin/{tagId}).
//
// (n1, n2) may be equal or different; both cases must yield 409 on the second
// attempt since the tag already holds a binding. Distinct pairs exercise the
// "n2 is brand new" case, proving the rejection comes from the tag-level
// binding rather than from a nickname-uniqueness collision.
//
// Validates: Requirements 3.7

// A pair of valid nicknames. Generated independently so the pair is usually
// distinct (exercising the "n2 is brand new" case) but may occasionally be
// equal — both must still yield 409 already_registered on the second attempt.
const validNicknamePairArb = fc.tuple(validNicknameArb, validNicknameArb);

describe('Property 8: Tag-level registration idempotence', () => {
  beforeEach(() => {
    setClock(() => AFTER_GATE_TIME);
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClock();
    setDocClient(null);
    delete process.env.TABLE_NAME;
  });

  // Validates: Requirements 3.7
  it('a second registration for an already-registered tag returns 409 already_registered and leaves the binding unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(validNicknamePairArb, async ([n1, n2]) => {
        const tagId = 'tag-prop8';
        // Fresh store per run, seeded with an eligible set of 10 check-ins.
        const client = createInMemoryClient(buildEligibleCheckins(tagId));
        setDocClient(client);

        // 1. First registration with n1 — must succeed for an eligible tag.
        const firstRes = await handleNicknameRegister({ tagId, nickname: n1 });
        expect(firstRes.statusCode).toBe(200);
        expect(JSON.parse(firstRes.body).nickname).toBe(n1);

        // 2. Second registration with n2 — the tag already holds a binding, so
        //    the TAG#{tagId}/NICKNAME conditional Put fails
        //    (CancellationReasons[0]) -> 409 already_registered, regardless of
        //    whether n2 is brand new.
        const secondRes = await handleNicknameRegister({ tagId, nickname: n2 });
        expect(secondRes.statusCode).toBe(409);
        expect(JSON.parse(secondRes.body).error).toBe('already_registered');

        // 3a. The persisted binding in the store is unchanged — still n1.
        const binding = client._store.get(`TAG#${tagId}|NICKNAME`);
        expect(binding).toBeDefined();
        expect(binding.nickname).toBe(n1);

        // 3b. GET /checkin/{tagId} also reports the original nickname n1.
        const progressRes = await handleProgress(tagId);
        expect(progressRes.statusCode).toBe(200);
        expect(JSON.parse(progressRes.body).nickname).toBe(n1);
      }),
      { numRuns: 200 }
    );
  });
});
