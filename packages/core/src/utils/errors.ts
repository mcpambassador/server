/**
 * Custom error classes
 *
 * All Ambassador errors extend AmbassadorError for consistent error handling.
 */

export class AmbassadorError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AmbassadorError';
  }
}

export class AuthenticationError extends AmbassadorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'authentication_failed', 401, details);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends AmbassadorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'access_denied', 403, details);
    this.name = 'AuthorizationError';
  }
}

export class ValidationError extends AmbassadorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'validation_failed', 400, details);
    this.name = 'ValidationError';
  }
}

export class ServiceUnavailableError extends AmbassadorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'service_unavailable', 503, details);
    this.name = 'ServiceUnavailableError';
  }
}

export class BadGatewayError extends AmbassadorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'downstream_error', 502, details);
    this.name = 'BadGatewayError';
  }
}
