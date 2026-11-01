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

/** Never approvable (server answers 409). Mirrors TOOL_PIN_BLOCKING_FLAG_CODES; `oversize` is the pending ADR-021 name. */
export const NON_APPROVABLE_FLAGS = [
  'reserved_name',
  'invalid_definition',
  'oversize',
  'canonical_too_large',
];
