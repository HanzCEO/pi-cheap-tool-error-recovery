import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig, updateConfig } from "./config";
import {
  classifyRecoverable,
  formatSchemaErrors,
  type JsonSchema,
  type ToolDescriptor,
} from "./schema";
import {
  buildRecoveryMessages,
  resolveRecoveryTarget,
  callRecoveryModel,
  directRecoveryTarget,
} from "./recovery";
import { planBlockRecovery } from "./handler";
import { pickRecoveryModel } from "./picker";

/**
 * cheap-tool-error-recovery
 *
 * Intercepts tool calls whose arguments fail the tool's schema, asks a
 * separately selectable recovery LLM for a corrected call, and patches the
 * call's arguments so the corrected tool runs for real. The assistant only ever
 * sees the corrected result.
 *
 * Interception happens at `message_end` (not `tool_call`): pi validates tool
 * arguments and rejects schema-invalid calls before the `tool_call` event ever
 * fires, so a pre-execution patch there is impossible. `message_end` fires as
 * the assistant message is finalized, before validation and execution, which is
 * where we rewrite the tool-call arguments.
 */
interface ToolCallBlock {
  type?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("cheap-tool-error-recovery loaded", "info");
  });

  pi.on("message_end", async (event: MessageEndEvent, ctx: ExtensionContext) => {
    const msg = event.message as unknown as { role?: string; content?: unknown[] };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;

    const cfg = loadConfig();
    if (!cfg.enabled) return; // disabled: pass through untouched
    if (!cfg.model && !cfg.recoveryBaseUrl) return; // nothing configured: pass through

    const tools: ToolDescriptor[] = pi
      .getAllTools()
      .map((t) => ({ name: t.name, parameters: t.parameters as unknown as JsonSchema }));

    let changed = false;

    for (const block of msg.content as ToolCallBlock[]) {
      if (block.type !== "toolCall" || typeof block.name !== "string" || !block.arguments) continue;

      const classification = classifyRecoverable(block.name, block.arguments, tools);
      if (!classification.recoverable) continue;

      const errorText = formatSchemaErrors(classification.errors);
      const messages = buildRecoveryMessages(
        tools,
        { toolName: block.name, input: block.arguments },
        errorText,
      );

      try {
        const target = cfg.recoveryBaseUrl
          ? directRecoveryTarget(cfg.recoveryBaseUrl, cfg.recoveryApiKey, cfg.recoveryModelId)
          : await resolveRecoveryTarget(ctx.modelRegistry, cfg.model!);
        if (!target) {
          ctx.ui.notify("tool-recovery: no auth for the selected recovery model", "warning");
          continue;
        }

        const recovered = await callRecoveryModel(target, messages, { signal: ctx.signal });

        const plan = planBlockRecovery(block.name, block.arguments, recovered, tools);
        if (plan.apply && plan.corrected) {
          block.name = plan.corrected.toolName;
          block.arguments = plan.corrected.args;
          changed = true;
          ctx.ui.notify(`tool-recovery: rewrote '${plan.corrected.toolName}' call`, "info");
        } else {
          ctx.ui.notify(`tool-recovery skipped: ${plan.reason}`, "warning");
        }
      } catch (err) {
        // Recovery failed: leave the original (invalid) call untouched so the real
        // error surfaces to the assistant instead of being silently swallowed.
        ctx.ui.notify(
          `tool-recovery failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }

    if (changed) return { message: event.message };
  });

  pi.registerCommand("toolrecovery-model", {
    description: "Choose the LLM that fixes broken tool calls",
    handler: async (_args, ctx) => {
      const picked = await pickRecoveryModel(ctx);
      if (!picked) {
        ctx.ui.notify("Recovery model unchanged", "info");
        return;
      }
      updateConfig({ model: picked });
      ctx.ui.notify(`tool-recovery model set to ${picked.provider}/${picked.id}`, "info");
    },
  });

  pi.registerCommand("toolrecovery", {
    description: "Toggle tool-call error recovery (on/off/status)",
    handler: async (args, ctx) => {
      const cfg = loadConfig();
      const arg = args.trim().toLowerCase();
      let next: boolean;
      if (arg === "on" || arg === "enable") next = true;
      else if (arg === "off" || arg === "disable") next = false;
      else if (arg === "status") {
        const model = cfg.model ? `${cfg.model.provider}/${cfg.model.id}` : "none";
        ctx.ui.notify(`tool-recovery: ${cfg.enabled ? "enabled" : "disabled"}, model: ${model}`, "info");
        return;
      } else {
        next = !cfg.enabled;
      }
      updateConfig({ enabled: next });
      ctx.ui.notify(`tool-recovery ${next ? "enabled" : "disabled"}`, next ? "info" : "warning");
    },
  });
}
