"use strict";
/**
 * Error classes for Zengram SDK
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionError = exports.TimeoutError = exports.PermissionError = exports.ValidationError = exports.NotFoundError = exports.AuthenticationError = exports.RateLimitError = exports.BrainError = void 0;
/**
 * Base error class for all Brain API errors
 */
class BrainError extends Error {
    /** HTTP status code from API */
    statusCode;
    /** Raw response body from API */
    responseBody;
    constructor(message, statusCode, responseBody) {
        super(message);
        this.name = 'BrainError';
        this.statusCode = statusCode;
        this.responseBody = responseBody;
        // Set prototype for instanceof checks
        Object.setPrototypeOf(this, BrainError.prototype);
    }
}
exports.BrainError = BrainError;
/**
 * Raised when API returns 429 Too Many Requests
 */
class RateLimitError extends BrainError {
    /** Seconds to wait before retrying */
    retryAfter;
    constructor(message, retryAfter, statusCode, responseBody) {
        super(message, statusCode || 429, responseBody);
        this.name = 'RateLimitError';
        this.retryAfter = retryAfter;
        Object.setPrototypeOf(this, RateLimitError.prototype);
    }
}
exports.RateLimitError = RateLimitError;
/**
 * Raised when API returns 401 Unauthorized
 */
class AuthenticationError extends BrainError {
    constructor(message, responseBody) {
        super(message, 401, responseBody);
        this.name = 'AuthenticationError';
        Object.setPrototypeOf(this, AuthenticationError.prototype);
    }
}
exports.AuthenticationError = AuthenticationError;
/**
 * Raised when API returns 404 Not Found
 */
class NotFoundError extends BrainError {
    constructor(message, responseBody) {
        super(message, 404, responseBody);
        this.name = 'NotFoundError';
        Object.setPrototypeOf(this, NotFoundError.prototype);
    }
}
exports.NotFoundError = NotFoundError;
/**
 * Raised when API returns 400 Bad Request
 */
class ValidationError extends BrainError {
    constructor(message, responseBody) {
        super(message, 400, responseBody);
        this.name = 'ValidationError';
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}
exports.ValidationError = ValidationError;
/**
 * Raised when API returns 403 Forbidden
 */
class PermissionError extends BrainError {
    constructor(message, responseBody) {
        super(message, 403, responseBody);
        this.name = 'PermissionError';
        Object.setPrototypeOf(this, PermissionError.prototype);
    }
}
exports.PermissionError = PermissionError;
/**
 * Raised when request times out
 */
class TimeoutError extends BrainError {
    constructor(message) {
        super(message);
        this.name = 'TimeoutError';
        Object.setPrototypeOf(this, TimeoutError.prototype);
    }
}
exports.TimeoutError = TimeoutError;
/**
 * Raised when network connection fails
 */
class ConnectionError extends BrainError {
    constructor(message) {
        super(message);
        this.name = 'ConnectionError';
        Object.setPrototypeOf(this, ConnectionError.prototype);
    }
}
exports.ConnectionError = ConnectionError;
//# sourceMappingURL=errors.js.map