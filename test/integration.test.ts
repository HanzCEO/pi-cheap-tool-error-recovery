import { describe, it, expect } from "vitest";
import {
  classifyRecoverable,
  formatSchemaErrors,
  type ToolDescriptor,
} from "../src/schema";
import { buildRecoveryMessages, parseRecoveryResponse, type RecoveredCall } from "../src/recovery";
import { planBlockRecovery } from "../src/handler";

const tools: ToolDescriptor[] = [
  {
    name: "write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

/**
 * End-to-end logic check for the documented example, without a live model.
 * Mirrors exactly what the `message_end` handler does, step by step, against a
 * real assistant-message toolCall block.
 */
describe("example scenario: write(filename=...) recovery", () => {
  it("detects the schema error, asks the recovery model, and rewrites the toolCall block", () => {
    // 1. The assistant message contains a toolCall block with a bad argument name.
    const block: { type: string; name: string; arguments: Record<string, unknown> } = {
      type: "toolCall",
      name: "write",
      arguments: { filename: "abc.txt", content: "hello world" },
    };

    // 2. The handler classifies the call against the schema.
    const classification = classifyRecoverable(block.name, block.arguments, tools);
    expect(classification.recoverable).toBe(true);
    const errorText = formatSchemaErrors(classification.errors);

    // 3. The recovery prompt carries the failing call, the error, and the schema.
    const messages = buildRecoveryMessages(tools, { toolName: block.name, input: block.arguments }, errorText);
    const all = messages.map((m) => m.content).join("\n");
    expect(all).toContain('"filename": "abc.txt"');
    expect(all).toContain("unknown property 'filename'");
    expect(all).toContain('"path"');

    // 4. The recovery model returns a corrected call (what parseRecoveryResponse yields).
    const corrected: RecoveredCall = parseRecoveryResponse(
      '{"toolName":"write","args":{"path":"abc.txt","content":"hello world"}}',
    );
    expect(corrected.toolName).toBe("write");

    // 5. The handler decides whether to apply it and rewrites the block in place.
    const plan = planBlockRecovery(block.name, block.arguments, corrected, tools);
    expect(plan.apply).toBe(true);
    expect(plan.corrected?.args).toEqual({ path: "abc.txt", content: "hello world" });

    block.name = plan.corrected!.toolName;
    block.arguments = plan.corrected!.args;

    expect(block).toEqual({
      type: "toolCall",
      name: "write",
      arguments: { path: "abc.txt", content: "hello world" },
    });
    expect((block.arguments as { filename?: string }).filename).toBeUndefined();
  });
});
