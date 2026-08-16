export const ERROR_CODES = {
  INVALID_CREDENTIALS: { status: 401, message: 'Wrong username or password' },
  TOKEN_EXPIRED: { status: 401, message: 'Access token expired' },
  TOKEN_INVALID: { status: 401, message: 'Malformed or invalid token' },
  UNAUTHORIZED: { status: 401, message: 'Authentication required' },
  FORBIDDEN: { status: 403, message: 'Insufficient permissions' },
  NOT_FOUND: { status: 404, message: 'Resource not found' },
  VALIDATION_ERROR: { status: 422, message: 'Request validation failed' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Uploaded file is too large' },
  DUPLICATE_RFID: { status: 409, message: 'RFID UID already registered' },
  DUPLICATE_ID: { status: 409, message: 'ID number already registered' },
  DUPLICATE_PLATE: { status: 409, message: 'Plate number already registered' },
  DUPLICATE_SERIAL: { status: 409, message: 'Serial number already registered' },
  DUPLICATE_USERNAME: { status: 409, message: 'Username already taken' },
  CONFLICT: { status: 409, message: 'Request conflicts with existing state' },
  CARD_BLOCKED: { status: 409, message: 'This card has been permanently blocked and cannot be reused' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  INTERNAL_ERROR: { status: 500, message: 'Internal server error' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
