/**
 * API Response Envelope Helpers
 *
 * Helper functions to wrap responses in the standard API envelope format.
 * All API responses follow the pattern:
 * - Success: { ok: true, data: T }
 * - Paginated: { ok: true, data: T[], pagination: {...} }
 * - Error: { ok: false, error: { code, message, details? } }
 *
 * @see packages/contracts/src/envelope.ts for TypeScript types
 * @see Architecture §16.4 Admin API Design Principles
 */

import type {
  SuccessEnvelope,
  PaginatedEnvelope,
  ErrorEnvelope,
} from '@mcpambassador/contracts';
import { ErrorCodes } from '@mcpambassador/contracts';

export { ErrorCodes };

/**
 * Pagination metadata structure
 */
export interface PaginationMetadata {
  has_more: boolean;
  total_count: number;
  next_cursor?: string | null;
}

/**
 * Wrap data in a success envelope
 *
 * @param data The data to return
 * @returns Success envelope { ok: true, data }
 *
 * @example
 * return reply.send(wrapSuccess({ user_id: 123 }));
 */
export function wrapSuccess<T>(data: T): SuccessEnvelope<T> {
  return { ok: true, data };
}

/**
 * Wrap paginated data in a success envelope
 *
 * @param data Array of items
 * @param pagination Pagination metadata
 * @returns Paginated envelope { ok: true, data, pagination }
 *
 * @example
 * return reply.send(wrapPaginated(users, { has_more: true, total_count: 100 }));
 */
export function wrapPaginated<T>(
  data: T[],
  pagination: PaginationMetadata
): PaginatedEnvelope<T> {
  return { ok: true, data, pagination };
}

/**
 * Wrap error in an error envelope
 *
 * @param code Error code from ErrorCodes
 * @param message Human-readable error message
 * @param details Optional additional error details
 * @returns Error envelope { ok: false, error: { code, message, details? } }
 *
 * @example
 * return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'User not found'));
 */
export function wrapError(
  code: string,
  message: string,
  details?: unknown[]
): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
  };
}
