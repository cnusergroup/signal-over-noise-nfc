/**
 * Time utilities — injectable clock for testing, TTL calculator, ISO helpers.
 */

let clockFn = () => Date.now();

/**
 * Returns the current time in milliseconds.
 * Uses an injectable clock function for testability.
 * @returns {number} Current time in ms
 */
export function now() {
  return clockFn();
}

/**
 * Returns the current time as an ISO 8601 UTC string.
 * @returns {string}
 */
export function isoNow() {
  return new Date(now()).toISOString();
}

/**
 * Converts milliseconds to ISO 8601 UTC string.
 * @param {number} ms - Time in milliseconds
 * @returns {string}
 */
export function toISO(ms) {
  return new Date(ms).toISOString();
}

/**
 * Converts ISO 8601 string to milliseconds.
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {number} Time in milliseconds
 */
export function fromISO(isoString) {
  return new Date(isoString).getTime();
}

/**
 * Calculates TTL for a check-in record (creation time + 30 days).
 * @param {number} creationTimeMs - Creation time in milliseconds
 * @returns {number} TTL as Unix epoch seconds
 */
export function checkinTTL(creationTimeMs) {
  return Math.floor(creationTimeMs / 1000) + 30 * 24 * 60 * 60;
}

/**
 * Calculates TTL for a mission record (end time + 30 days).
 * @param {number} endTimeMs - Mission end time in milliseconds
 * @returns {number} TTL as Unix epoch seconds
 */
export function missionTTL(endTimeMs) {
  return Math.floor(endTimeMs / 1000) + 30 * 24 * 60 * 60;
}

/**
 * Checks if a record is expired based on its TTL value.
 * @param {number} ttlSeconds - TTL value in Unix epoch seconds
 * @returns {boolean} True if expired (TTL < current time in seconds)
 */
export function isExpired(ttlSeconds) {
  const currentSeconds = Math.floor(now() / 1000);
  return ttlSeconds < currentSeconds;
}

/**
 * Filters out expired records from an array.
 * Records without a ttl field are kept.
 * @param {Array<object>} records - Array of records with optional ttl field
 * @returns {Array<object>} Records that are not expired
 */
export function filterExpired(records) {
  return records.filter(record => {
    if (record.ttl === undefined || record.ttl === null) {
      return true;
    }
    return !isExpired(record.ttl);
  });
}

/**
 * Injects a custom clock function (for testing).
 * @param {Function} fn - Function returning current time in ms
 */
export function setClock(fn) {
  clockFn = fn;
}

/**
 * Resets the clock to the real system clock.
 */
export function resetClock() {
  clockFn = () => Date.now();
}

let CACHED_TIME_GATE_MS = null;

/**
 * Returns the After Party time gate as Unix epoch milliseconds.
 *
 * Reads the AFTER_PARTY_TIME_GATE environment variable (ISO 8601 UTC),
 * defaulting to 2026-06-28T09:00:00Z (June 28, 2026, 17:00 CST). The parsed
 * value is cached on first read. Parsing happens at module load time via the
 * first call, so a malformed value surfaces as a Lambda init error and
 * prevents the function from accepting traffic (Requirement 1.4).
 *
 * @returns {number} The time gate as Unix epoch milliseconds
 * @throws {Error} If AFTER_PARTY_TIME_GATE is set but not a valid ISO 8601 timestamp
 */

let DYNAMIC_TIME_GATE_MS = null;

/**
 * Set a dynamic override for the After Party time gate (from admin config API).
 * @param {?number} ms - Unix epoch ms, or null to clear.
 */
export function setTimeGateOverride(ms) {
  DYNAMIC_TIME_GATE_MS = ms;
  if (ms != null) CACHED_TIME_GATE_MS = ms;
}

export function getAfterPartyTimeGateMs() {
  if (DYNAMIC_TIME_GATE_MS !== null) return DYNAMIC_TIME_GATE_MS;
  if (CACHED_TIME_GATE_MS !== null) return CACHED_TIME_GATE_MS;
  const raw = process.env.AFTER_PARTY_TIME_GATE || '2025-01-01T00:00:00Z';
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid AFTER_PARTY_TIME_GATE value: ${raw}. Expected ISO 8601 UTC.`);
  }
  CACHED_TIME_GATE_MS = ms;
  return ms;
}

/**
 * Returns true if the given timestamp is at or after the After Party time gate.
 *
 * Accepts either an ISO 8601 string or a Unix epoch milliseconds number.
 *
 * @param {number|string} timestamp - ISO 8601 string or Unix epoch milliseconds
 * @returns {boolean} True if the timestamp is at or after the time gate
 */
export function isAfterPartyCheckin(timestamp) {
  const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  return ms >= getAfterPartyTimeGateMs();
}
