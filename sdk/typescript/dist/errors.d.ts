/**
 * Error classes for Zengram SDK
 */
/**
 * Base error class for all Brain API errors
 */
export declare class BrainError extends Error {
    /** HTTP status code from API */
    readonly statusCode?: number;
    /** Raw response body from API */
    readonly responseBody?: string;
    constructor(message: string, statusCode?: number, responseBody?: string);
}
/**
 * Raised when API returns 429 Too Many Requests
 */
export declare class RateLimitError extends BrainError {
    /** Seconds to wait before retrying */
    readonly retryAfter?: number;
    constructor(message: string, retryAfter?: number, statusCode?: number, responseBody?: string);
}
/**
 * Raised when API returns 401 Unauthorized
 */
export declare class AuthenticationError extends BrainError {
    constructor(message: string, responseBody?: string);
}
/**
 * Raised when API returns 404 Not Found
 */
export declare class NotFoundError extends BrainError {
    constructor(message: string, responseBody?: string);
}
/**
 * Raised when API returns 400 Bad Request
 */
export declare class ValidationError extends BrainError {
    constructor(message: string, responseBody?: string);
}
/**
 * Raised when API returns 403 Forbidden
 */
export declare class PermissionError extends BrainError {
    constructor(message: string, responseBody?: string);
}
/**
 * Raised when request times out
 */
export declare class TimeoutError extends BrainError {
    constructor(message: string);
}
/**
 * Raised when network connection fails
 */
export declare class ConnectionError extends BrainError {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map