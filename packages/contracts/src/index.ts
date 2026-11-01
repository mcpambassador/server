/**
 * @mcpambassador/contracts
 *
 * SCOPE: the ADMIN/SPA API (port 9443) envelope — `{ ok: true, data }` /
 * `{ ok: false, error }`. The client-port (8443) wire format is described by
 * @mcpambassador/protocol and does NOT use this envelope.
 */
// API envelope types and schemas
export {
  successEnvelopeSchema,
  paginatedEnvelopeSchema,
  errorEnvelopeSchema,
  apiResponseSchema,
  type SuccessEnvelope,
  type PaginatedEnvelope,
  type ErrorEnvelope,
  type ApiResponse,
} from './envelope.js';

// Standard error codes
export { ErrorCodes, type ErrorCode } from './error-codes.js';

// ADR-020 remote agent endpoint contracts
export * from './agent-endpoint.js';

// Admin kill switches (TD-022)
export * from './kill-switch.js';
