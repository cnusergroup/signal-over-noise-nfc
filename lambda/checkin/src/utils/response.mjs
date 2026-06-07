/**
 * Response utilities — standardized JSON response builder with convenience methods.
 */

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

/**
 * Builds a standardized API Gateway response.
 * @param {number} statusCode - HTTP status code
 * @param {object|string} body - Response body (will be JSON-stringified if object)
 * @returns {object} API Gateway response object
 */
export function buildResponse(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/**
 * Builds a standardized error response.
 * @param {number} statusCode - HTTP status code
 * @param {string} errorCode - Machine-readable error code
 * @param {string} message - Human-readable error message
 * @param {string} [field] - Optional field name for validation errors
 * @returns {object} API Gateway response object
 */
export function buildErrorResponse(statusCode, errorCode, message, field) {
  const body = { error: errorCode, message };
  if (field) {
    body.field = field;
  }
  return buildResponse(statusCode, body);
}

// --- Convenience methods ---

/** 200 OK */
export function ok(body) {
  return buildResponse(200, body);
}

/** Alias for ok */
export const success = ok;

/** 201 Created */
export function created(body) {
  return buildResponse(201, body);
}

/** 204 No Content */
export function noContent() {
  return { statusCode: 204, headers: { ...CORS_HEADERS }, body: '' };
}

/** Generic error builder */
export function error(statusCode, errorCode, message, field) {
  return buildErrorResponse(statusCode, errorCode, message, field);
}

/** 400 Missing field */
export function missingField(fieldName) {
  return buildErrorResponse(400, 'missing_field', `Missing required field: ${fieldName}`, fieldName);
}

/** 400 Invalid field */
export function invalidField(fieldName, message) {
  return buildErrorResponse(400, 'invalid_field', message, fieldName);
}

/** 401 Unauthorized */
export function unauthorized(message = 'Authentication required') {
  return buildErrorResponse(401, 'unauthorized', message);
}

/** 404 Not found */
export function notFound(message = 'Resource not found') {
  return buildErrorResponse(404, 'not_found', message);
}

/** 409 Conflict */
export function conflict(message = 'Resource conflict') {
  return buildErrorResponse(409, 'conflict', message);
}

/** 429 Cooldown active */
export function cooldown(remainingSeconds, missions) {
  const body = { error: 'cooldown_active', remainingSeconds };
  if (missions) {
    body.missions = missions;
  }
  return buildResponse(429, body);
}

/** 500 Internal error */
export function internalError(message = 'An internal error occurred') {
  return buildErrorResponse(500, 'internal_error', message);
}
