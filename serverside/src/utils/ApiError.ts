import { ERROR_CODES, ErrorCode } from '../constants/errors';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(code: ErrorCode, message?: string) {
    const def = ERROR_CODES[code];
    super(message ?? def.message);
    this.status = def.status;
    this.code = code;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError('NOT_FOUND', message);
  }
}
