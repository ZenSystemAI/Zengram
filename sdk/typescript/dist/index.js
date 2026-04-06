"use strict";
/**
 * Zengram TypeScript SDK
 * A complete TypeScript client for the Zengram multi-agent memory system
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionError = exports.TimeoutError = exports.PermissionError = exports.ValidationError = exports.NotFoundError = exports.AuthenticationError = exports.RateLimitError = exports.BrainError = exports.BrainClient = void 0;
var client_1 = require("./client");
Object.defineProperty(exports, "BrainClient", { enumerable: true, get: function () { return client_1.BrainClient; } });
// Error classes
var errors_1 = require("./errors");
Object.defineProperty(exports, "BrainError", { enumerable: true, get: function () { return errors_1.BrainError; } });
Object.defineProperty(exports, "RateLimitError", { enumerable: true, get: function () { return errors_1.RateLimitError; } });
Object.defineProperty(exports, "AuthenticationError", { enumerable: true, get: function () { return errors_1.AuthenticationError; } });
Object.defineProperty(exports, "NotFoundError", { enumerable: true, get: function () { return errors_1.NotFoundError; } });
Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function () { return errors_1.ValidationError; } });
Object.defineProperty(exports, "PermissionError", { enumerable: true, get: function () { return errors_1.PermissionError; } });
Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: function () { return errors_1.TimeoutError; } });
Object.defineProperty(exports, "ConnectionError", { enumerable: true, get: function () { return errors_1.ConnectionError; } });
//# sourceMappingURL=index.js.map