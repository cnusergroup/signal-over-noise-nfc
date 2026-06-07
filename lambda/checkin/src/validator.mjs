/**
 * Request validator — input validation for all endpoints.
 * Validates tagId, scannerId, stationId range, mission params, combo params, and API key.
 */

/**
 * Validates check-in request body fields.
 * @param {object} body - Parsed request body
 * @returns {{ valid: boolean, error?: string, field?: string, message?: string }}
 */
export function validateCheckinRequest(body) {
  if (!body) {
    return { valid: false, error: 'missing_field', field: 'tagId' };
  }
  if (!body.tagId || (typeof body.tagId === 'string' && body.tagId.trim() === '')) {
    return { valid: false, error: 'missing_field', field: 'tagId' };
  }
  if (!body.scannerId || (typeof body.scannerId === 'string' && body.scannerId.trim() === '')) {
    return { valid: false, error: 'missing_field', field: 'scannerId' };
  }
  return { valid: true };
}

/**
 * Validates a station identifier is an integer between 1 and 10.
 * @param {*} stationId - Value to validate
 * @returns {{ valid: boolean, error?: string, field?: string, message?: string }}
 */
export function validateStationId(stationId) {
  if (stationId === undefined || stationId === null || stationId === '') {
    return { valid: false, error: 'invalid_field', field: 'stationId', message: 'Station identifier must be an integer between 1 and 10' };
  }
  const num = Number(stationId);
  if (!Number.isInteger(num) || num < 1 || num > 10) {
    return { valid: false, error: 'invalid_field', field: 'stationId', message: 'Station identifier must be an integer between 1 and 10' };
  }
  return { valid: true };
}

/**
 * Validates a tagId is non-empty and non-whitespace.
 * @param {string} tagId - Tag identifier to validate
 * @returns {{ valid: boolean, error?: string, field?: string }}
 */
export function validateTagId(tagId) {
  if (!tagId || (typeof tagId === 'string' && tagId.trim() === '')) {
    return { valid: false, error: 'missing_field', field: 'tagId' };
  }
  return { valid: true };
}

/**
 * Validates mission creation/update parameters.
 * @param {object} body - Parsed request body
 * @param {boolean} [isUpdate=false] - If true, allows partial updates (fewer required fields)
 * @returns {{ valid: boolean, error?: string, field?: string, message?: string }}
 */
export function validateMissionParams(body, isUpdate = false) {
  if (!body) {
    return { valid: false, error: 'missing_field', field: 'type', message: 'Request body is required' };
  }

  // For creation, type, name, startTime, endTime are required
  if (!isUpdate) {
    if (!body.type || (typeof body.type === 'string' && body.type.trim() === '')) {
      return { valid: false, error: 'missing_field', field: 'type' };
    }

    const validTypes = ['numbered_visit', 'lucky_draw', 'early_bird', 'last_call'];
    if (!validTypes.includes(body.type)) {
      return { valid: false, error: 'invalid_field', field: 'type', message: `Mission type must be one of: ${validTypes.join(', ')}` };
    }

    if (!body.name || (typeof body.name === 'string' && body.name.trim() === '')) {
      return { valid: false, error: 'missing_field', field: 'name' };
    }

    if (!body.startTime) {
      return { valid: false, error: 'missing_field', field: 'startTime' };
    }

    if (!body.endTime) {
      return { valid: false, error: 'missing_field', field: 'endTime' };
    }
  }

  // Name length validation (applies to both create and update if name is provided)
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return { valid: false, error: 'missing_field', field: 'name' };
    }
    if (body.name.length > 200) {
      return { valid: false, error: 'invalid_field', field: 'name', message: 'Mission name must not exceed 200 characters' };
    }
  }

  // Time validation (applies if both are provided)
  if (body.startTime && body.endTime) {
    const start = new Date(body.startTime).getTime();
    const end = new Date(body.endTime).getTime();
    if (isNaN(start)) {
      return { valid: false, error: 'invalid_field', field: 'startTime', message: 'Start time must be a valid ISO 8601 timestamp' };
    }
    if (isNaN(end)) {
      return { valid: false, error: 'invalid_field', field: 'endTime', message: 'End time must be a valid ISO 8601 timestamp' };
    }
    if (end <= start) {
      return { valid: false, error: 'invalid_field', field: 'endTime', message: 'End time must be after start time' };
    }
  }

  // Station ID validation (if provided)
  if (body.stationId !== undefined) {
    const stationValidation = validateStationId(body.stationId);
    if (!stationValidation.valid) {
      return stationValidation;
    }
  }

  // Type-specific validation
  if (body.type === 'numbered_visit') {
    if (!isUpdate && (!body.milestones || !Array.isArray(body.milestones) || body.milestones.length === 0)) {
      return { valid: false, error: 'missing_field', field: 'milestones' };
    }
    if (body.milestones) {
      if (!Array.isArray(body.milestones) || body.milestones.length === 0 || body.milestones.length > 100) {
        return { valid: false, error: 'invalid_field', field: 'milestones', message: 'Milestones must be an array of 1 to 100 positive integers' };
      }
      for (const m of body.milestones) {
        if (!Number.isInteger(m) || m < 1) {
          return { valid: false, error: 'invalid_field', field: 'milestones', message: 'Each milestone must be a positive integer' };
        }
      }
    }
  }

  if (body.type === 'lucky_draw') {
    if (!isUpdate && body.winnerCount === undefined) {
      return { valid: false, error: 'missing_field', field: 'winnerCount' };
    }
    if (body.winnerCount !== undefined) {
      if (!Number.isInteger(body.winnerCount) || body.winnerCount < 1 || body.winnerCount > 100) {
        return { valid: false, error: 'invalid_field', field: 'winnerCount', message: 'Winner count must be an integer between 1 and 100' };
      }
    }
    if (body.prizeDescription !== undefined) {
      if (typeof body.prizeDescription !== 'string' || body.prizeDescription.length > 500) {
        return { valid: false, error: 'invalid_field', field: 'prizeDescription', message: 'Prize description must not exceed 500 characters' };
      }
    }
  }

  if (body.type === 'early_bird' || body.type === 'last_call') {
    if (!isUpdate && body.winnerCount === undefined) {
      return { valid: false, error: 'missing_field', field: 'winnerCount' };
    }
    if (body.winnerCount !== undefined) {
      if (!Number.isInteger(body.winnerCount) || body.winnerCount < 1 || body.winnerCount > 100) {
        return { valid: false, error: 'invalid_field', field: 'winnerCount', message: 'Winner count must be an integer between 1 and 100' };
      }
    }
    if (body.bonusPoints !== undefined) {
      if (!Number.isInteger(body.bonusPoints) || body.bonusPoints < 1) {
        return { valid: false, error: 'invalid_field', field: 'bonusPoints', message: 'Bonus points must be a positive integer' };
      }
    }
  }

  return { valid: true };
}

/**
 * Validates a lottery nickname.
 *
 * Accepts a string of length 1 to 20 (inclusive) that has no leading or
 * trailing whitespace and contains no Unicode control characters (general
 * category `Cc`). All other printable Unicode characters are allowed,
 * including CJK, emoji, and combining marks.
 *
 * @param {*} s - Candidate nickname value
 * @returns {{ ok: true } | { ok: false, code: 'invalid_field' | 'missing_field', message: string }}
 */
export function validateNickname(s) {
  if (s === undefined || s === null || typeof s !== 'string') {
    return { ok: false, code: 'missing_field', message: 'Nickname is required' };
  }
  if (s.replace(/^\s+|\s+$/g, '').length === 0) {
    return { ok: false, code: 'invalid_field', message: 'Nickname must not be empty or whitespace only' };
  }
  if (s !== s.replace(/^\s+|\s+$/g, '')) {
    return { ok: false, code: 'invalid_field', message: 'Nickname must not have leading or trailing whitespace' };
  }
  if (s.length > 20) {
    return { ok: false, code: 'invalid_field', message: 'Nickname must not exceed 20 characters' };
  }
  if (/\p{Cc}/u.test(s)) {
    return { ok: false, code: 'invalid_field', message: 'Nickname must not contain control characters' };
  }
  return { ok: true };
}

/**
 * Validates combo bonus creation parameters.
 * @param {object} body - Parsed request body
 * @returns {{ valid: boolean, error?: string, field?: string, message?: string }}
 */
export function validateComboParams(body) {
  if (!body) {
    return { valid: false, error: 'missing_field', field: 'name', message: 'Request body is required' };
  }

  if (!body.name || (typeof body.name === 'string' && body.name.trim() === '')) {
    return { valid: false, error: 'missing_field', field: 'name' };
  }

  if (typeof body.name !== 'string' || body.name.length > 100) {
    return { valid: false, error: 'invalid_field', field: 'name', message: 'Combo name must not exceed 100 characters' };
  }

  if (!body.stations || !Array.isArray(body.stations)) {
    return { valid: false, error: 'missing_field', field: 'stations' };
  }

  if (body.stations.length < 2 || body.stations.length > 10) {
    return { valid: false, error: 'invalid_field', field: 'stations', message: 'Stations must contain between 2 and 10 station identifiers' };
  }

  // Check for duplicates
  const uniqueStations = new Set(body.stations);
  if (uniqueStations.size !== body.stations.length) {
    return { valid: false, error: 'invalid_field', field: 'stations', message: 'Stations must not contain duplicates' };
  }

  // Check each station is valid (integer 1-10)
  for (const station of body.stations) {
    if (!Number.isInteger(station) || station < 1 || station > 10) {
      return { valid: false, error: 'invalid_field', field: 'stations', message: 'Each station identifier must be an integer between 1 and 10' };
    }
  }

  if (!body.reward || (typeof body.reward === 'string' && body.reward.trim() === '')) {
    return { valid: false, error: 'missing_field', field: 'reward' };
  }

  if (typeof body.reward !== 'string' || body.reward.length > 200) {
    return { valid: false, error: 'invalid_field', field: 'reward', message: 'Reward description must not exceed 200 characters' };
  }

  return { valid: true };
}
