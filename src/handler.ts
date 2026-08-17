/**
 * Recovery decision logic for the `message_end` handler.
 *
 * `planBlockRecovery` is kept pure so the decide/apply branch can be unit-tested
 * without a live model or a running pi session. The handler (in index.ts)
 * validates a tool-call block's arguments, asks the recovery model for a fix,
 * then uses `planBlockRecovery` to confirm the corrected call is safe to apply.
 *
 * Unlike the original tool_call design, this runs before pi validates the call,
 * because the `message_end` event fires as the assistant message is finalized
 * and before tool execution. That is what makes recovering schema-invalid calls
 * possible: pi rejects them during validation, so the tool_call event would
 * never fire for them.
 */

import {
  validateInput,
  formatSchemaErrors,
  type ToolDescriptor,
} from "./schema";
import type { RecoveredCall } from "./recovery";

export interface CorrectedBlock {
  toolName: string;
  args: Record<string, unknown>;
}

export function planBlockRecovery(
  _originalToolName: string,
  _originalArgs: Record<string, unknown>,
  recovered: RecoveredCall,
  toolList: ToolDescriptor[],
): { apply: boolean; reason: string; corrected?: CorrectedBlock } {
  const tool = toolList.find((t) => t.name === recovered.toolName);
  if (!tool) {
    return { apply: false, reason: `recovered tool '${recovered.toolName}' is not available` };
  }

  const errors = validateInput(tool.parameters, recovered.args);
  if (errors.length > 0) {
    return {
      apply: false,
      reason: `recovered args still invalid: ${formatSchemaErrors(errors)}`,
    };
  }

  return {
    apply: true,
    reason: "corrected call validated",
    corrected: { toolName: recovered.toolName, args: recovered.args },
  };
}
