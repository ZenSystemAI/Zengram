/**
 * Error classes for Zengram SDK
 */

/**
 * Base error class for all Brain API errors
 */
export class BrainError extends Error {
  /** HTTP status code from API */
  public readonly statusCode?: number;
  /** Raw response body from API */
  public readonly responseBody?: string;

  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message);
    this.name = 'BrainError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;

    // Set prototype for instanceof checks
    Object.setPrototypeOf(this, BrainError.prototype);
  }
}

/**
 * Raised when API returns 429 Too Many Requests
 */
export class RateLimitError extends BrainError {
  /** Seconds to wait before retrying */
  public readonly retryAfter?: number;

  constructor(message: string, retryAfter?: number, statusCode?: number, responseBody?: string) {
    super(message, statusCode || 429, responseBody);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;

    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * Raised when API returns 401 Unauthorized
 */
export class AuthenticationError extends BrainError {
  constructor(message: string, responseBody?: string) {
    super(message, 401, responseBody);
    this.name = 'AuthenticationError';

    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Raised when API returns 404 Not Found
 */
export class NotFoundError extends BrainError {
  constructor(message: string, responseBody?: string) {
    super(message, 404, responseBody);
    this.name = 'NotFoundError';

    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * Raised when API returns 400 Bad Request
 */
export class ValidationError extends BrainError {
  constructor(message: string, responseBody?: string) {
    super(message, 400, responseBody);
    this.name = 'ValidationError';

    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Raised when API returns 403 Forbidden
 */
export class PermissionError extends BrainError {
  constructor(message: string, responseBody?: string) {
    super(message, 403, responseBody);
    this.name = 'PermissionError';

    Object.setPrototypeOf(this, PermissionError.prototype);
  }
}

/**
 * Raised when request times out
 */
export class TimeoutError extends BrainError {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';

    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Raised when network connection fails
 */
export class ConnectionError extends BrainError {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';

    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}
