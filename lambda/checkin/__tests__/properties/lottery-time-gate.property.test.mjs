// Feature: after-party-lottery, Property 1: Time gate classification
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.4
//
// Property 1a — Classification: for any Unix-ms timestamp T and any valid ISO 8601
//   gate string G, isAfterPartyCheckin(T) === (T >= Date.parse(G)).
// Property 1b — Malformed gate: for any string G where Number.isNaN(Date.parse(G)),
//   importing the module with AFTER_PARTY_TIME_GATE=G and invoking the gate accessor
//   SHALL throw an Error whose message contains G.
//
// The module under test (src/utils/time.mjs) caches the parsed gate value at module
// scope, so each case sets process.env.AFTER_PARTY_TIME_GATE, calls vi.resetModules(),
// and re-imports the module to force a fresh parse.

import { describe, it, afterEach, expect, vi } from 'vitest';
import fc from 'fast-check';

const ENV_KEY = 'AFTER_PARTY_TIME_GATE';
const ORIGINAL_GATE = process.env[ENV_KEY];

function restoreEnv() {
  if (ORIGINAL_GATE === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = ORIGINAL_GATE;
  }
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

/**
 * Loads a fresh copy of the time module after setting the gate env var, so the
 * module-level parse cache is re-evaluated against the provided gate value.
 * @param {string} gate - The AFTER_PARTY_TIME_GATE value to set
 * @returns {Promise<typeof import('../../src/utils/time.mjs')>}
 */
async function loadTimeModuleWithGate(gate) {
  process.env[ENV_KEY] = gate;
  vi.resetModules();
  return import('../../src/utils/time.mjs');
}

describe('Property 1: Time gate classification', () => {
  // Valid ISO 8601 gate strings: derived from integer ms in the representable
  // Date range so new Date(ms).toISOString() round-trips and Date.parse accepts it.
  // 1970-01-01 .. ~2100-01-01
  const validGateArb = fc
    .integer({ min: 0, max: 4102444800000 })
    .map((ms) => new Date(ms).toISOString());

  // Arbitrary integer Unix-ms timestamps spanning well before and after the gate.
  const timestampArb = fc.integer({ min: 0, max: 4102444800000 });

  it('1a — isAfterPartyCheckin(T) === (T >= Date.parse(G)) for valid gate strings', async () => {
    await fc.assert(
      fc.asyncProperty(timestampArb, validGateArb, async (T, G) => {
        const { isAfterPartyCheckin } = await loadTimeModuleWithGate(G);
        expect(isAfterPartyCheckin(T)).toBe(T >= Date.parse(G));
      }),
      { numRuns: 100 },
    );
  });

  it('1a (boundary) — timestamp exactly equal to the gate is classified as after-party', async () => {
    await fc.assert(
      fc.asyncProperty(validGateArb, async (G) => {
        const { isAfterPartyCheckin } = await loadTimeModuleWithGate(G);
        const gateMs = Date.parse(G);
        expect(isAfterPartyCheckin(gateMs)).toBe(true);
        expect(isAfterPartyCheckin(gateMs - 1)).toBe(false);
        expect(isAfterPartyCheckin(gateMs + 1)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('1b — malformed gate value causes the module to throw with a message containing G', async () => {
    // Generate non-empty strings that Date.parse rejects. Empty string is excluded
    // because the module falls back to the valid default when the env var is falsy.
    const malformedGateArb = fc
      .string()
      .filter((s) => s !== '' && Number.isNaN(Date.parse(s)));

    await fc.assert(
      fc.asyncProperty(malformedGateArb, async (G) => {
        const { getAfterPartyTimeGateMs } = await loadTimeModuleWithGate(G);
        let thrown;
        try {
          getAfterPartyTimeGateMs();
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.message).toContain(G);
      }),
      { numRuns: 100 },
    );
  });
});
