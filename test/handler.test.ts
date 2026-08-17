import { describe, it, expect } from "vitest";
import { planBlockRecovery } from "../src/handler";
import type { ToolDescriptor } from "../src/schema";
import type { RecoveredCall } from "../src/recovery";

const writeTool: ToolDescriptor = {
  name: "write",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

const editTool: ToolDescriptor = {
  name: "edit",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
};

const tools: ToolDescriptor[] = [writeTool, editTool];

describe("planBlockRecovery", () => {
  it("applies a same-tool correction whose args validate", () => {
    const recovered: RecoveredCall = { toolName: "write", args: { path: "abc.txt", content: "hello" } };
    const plan = planBlockRecovery("write", { filename: "abc.txt", content: "hello" }, recovered, tools);
    expect(plan.apply).toBe(true);
    expect(plan.corrected?.args).toEqual({ path: "abc.txt", content: "hello" });
  });

  it("allows a corrected tool when that tool's args validate", () => {
    const recovered: RecoveredCall = {
      toolName: "edit",
      args: { path: "abc.txt", oldText: "a", newText: "b" },
    };
    const plan = planBlockRecovery("write", { filename: "abc.txt" }, recovered, tools);
    expect(plan.apply).toBe(true);
    expect(plan.corrected?.toolName).toBe("edit");
  });

  it("does not apply when the recovered tool is not in the available list", () => {
    const recovered: RecoveredCall = { toolName: "ghost", args: {} };
    const plan = planBlockRecovery("write", { filename: "abc.txt" }, recovered, tools);
    expect(plan.apply).toBe(false);
    expect(plan.reason).toMatch(/not available/i);
  });

  it("does not apply when the corrected args are still invalid", () => {
    const recovered: RecoveredCall = { toolName: "write", args: { path: 123, content: "hello" } };
    const plan = planBlockRecovery("write", { filename: "abc.txt" }, recovered, tools);
    expect(plan.apply).toBe(false);
    expect(plan.reason).toMatch(/still invalid/i);
  });
});
