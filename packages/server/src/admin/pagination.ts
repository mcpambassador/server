/**
 * Pagination Helpers
 *
 * Utilities for cursor-based pagination and standard response envelopes.
 *
 * @see Architecture §16.4 Admin API Design Principles
 * @see dev-plan.md M8: Admin API Implementation
 */

/**
 * Pagination metadata
 */
export interface PaginationMetadata {
  next_cursor: string | null;
  has_more: boolean;
  total_count: number;
}

/**
 * Pagination envelope (standard response format)
 */
export interface PaginationEnvelope<T> {
  ok: true;
  data: T[];
  pagination: PaginationMetadata;
}

/**
 * Create pagination envelope
 *
 * @param data Array of items
 * @param pagination Pagination metadata
 * @returns Standard pagination envelope
 */
export function createPaginationEnvelope<T>(
  data: T[],
  pagination: PaginationMetadata
): PaginationEnvelope<T> {
  return {
    ok: true,
    data,
    pagination,
  };
}

/**
 * Parse cursor value
 *
 * @param cursor Cursor string (e.g., ISO timestamp, name, etc.)
 * @returns Parsed cursor or undefined if invalid
 */
export function parseCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  return cursor;
}
