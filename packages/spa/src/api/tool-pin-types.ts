/** Tool pinning (ADR-021) wire types: type-only imports from contracts. */
import type {
  ToolPinSummary,
  ToolPinDetail,
  ToolPinQueueSummary,
  ToolPinDecisionRequest,
  ToolPinConfirmBaselineRequest,
  ToolDefinition,
  PinPolicy,
} from '@mcpambassador/contracts';

export type {
  ToolPinSummary,
  ToolPinDetail,
  ToolPinQueueSummary,
  ToolPinDecisionRequest,
  ToolPinConfirmBaselineRequest,
  ToolDefinition,
  PinPolicy,
};

/**
 * Never approvable (server answers 409). Superset of the contract's TOOL_PIN_BLOCKING_FLAG_CODES
 * (a test keeps them in sync); canonical_too_large and duplicate_name are blocking too.
 */
export const NON_APPROVABLE_FLAGS: readonly string[] = [
  'reserved_name',
  'invalid_definition',
  'canonical_too_large',
  'duplicate_name',
];
