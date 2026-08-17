/**
 * End-to-end proof harness (committed test fixture, not the shipped extension).
 *
 * It imports the REAL shipped modules and runs the exact handler logic that
 * `src/index.ts` runs, with one addition: a deterministic fault injection that
 * renames `write`'s `path` argument to `filename` so the call is schema-invalid
 * (a stand-in for a model slip). This makes the full live chain reproducible
 * without depending on the assistant happening to emit an invalid call:
 *
 *   message_end -> classify invalid -> build prompt -> real recovery fetch
 *   -> parse -> planBlockRecovery (re-validate) -> rewrite block -> real execute
 *
 * Run via `npm run e2e`. To recover, it points at the mock server through
 * TOOLRECOVERY_BASE_URL.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import {
  classifyRecoverable,
  formatSchemaErrors,
  type ToolDescriptor,
  type JsonSchema,
} from "../src/schema";
import {
  buildRecoveryMessages,
  callRecoveryModel,
  directRecoveryTarget,
} from "../src/recovery";
import { planBlockRecovery } from "../src/handler";

interface TC {
  type?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as unknown as { role?: string; content?: unknown[] };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;

    const cfg = loadConfig();
    if (!cfg.enabled || (!cfg.model && !cfg.recoveryBaseUrl)) return;

    const tools: ToolDescriptor[] = pi
      .getAllTools()
      .map((t: { name: string; parameters: unknown }) => ({
        name: t.name,
        parameters: t.parameters as unknown as JsonSchema,
      }));

    let changed = false;

    for (const block of msg.content as TC[]) {
      if (block.type !== "toolCall" || typeof block.name !== "string" || !block.arguments) continue;

      // Deterministic fault injection: force the call invalid so detection runs.
      if (
        block.name === "write" &&
        typeof block.arguments.path === "string" &&
        !("filename" in block.arguments)
      ) {
        block.arguments.filename = block.arguments.path;
        delete block.arguments.path;
      }

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
          : null;
        if (!target) {
          ctx.ui.notify("no recovery target", "warning");
          continue;
        }

        const recovered = await callRecoveryModel(target, messages, { signal: ctx.signal });
        const plan = planBlockRecovery(block.name, block.arguments, recovered, tools);
        if (plan.apply && plan.corrected) {
          block.name = plan.corrected.toolName;
          block.arguments = plan.corrected.args;
          changed = true;
          writeFileSync(
            "/tmp/e2e_proof.txt",
            `RECOVERED name=${plan.corrected.toolName} args=${JSON.stringify(plan.corrected.args)}\n`,
            { flag: "a" },
          );
        } else {
          writeFileSync("/tmp/e2e_proof.txt", `SKIP ${plan.reason}\n`, { flag: "a" });
        }
      } catch (e) {
        writeFileSync("/tmp/e2e_proof.txt", `ERR ${String(e)}\n`, { flag: "a" });
      }
    }

    if (changed) return { message: event.message };
  });
}
