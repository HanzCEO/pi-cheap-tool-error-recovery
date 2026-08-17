import { describe, it, expect } from "vitest";
import {
  validateInput,
  classifyRecoverable,
  formatSchemaErrors,
  type JsonSchema,
  type ToolDescriptor,
} from "../src/schema";

const writeSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    append: { type: "boolean" },
  },
  required: ["path", "content"],
  additionalProperties: false,
};

const tools: ToolDescriptor[] = [
  { name: "write", parameters: writeSchema },
  {
    name: "log",
    parameters: {
      type: "object",
      properties: { message: { type: "string" }, level: { type: "string" } },
      required: ["message"],
      // extra properties explicitly allowed
      additionalProperties: true,
    },
  },
];

describe("validateInput", () => {
  it("passes a clean call", () => {
    const errors = validateInput(writeSchema, { path: "a.txt", content: "hi" });
    expect(errors).toEqual([]);
  });

  it("flags an unknown property", () => {
    const errors = validateInput(writeSchema, {
      path: "a.txt",
      content: "hi",
      filename: "a.txt",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "unknownProperty", property: "filename" });
  });

  it("flags a missing required property", () => {
    const errors = validateInput(writeSchema, { path: "a.txt" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "missingRequired", property: "content" });
  });

  it("flags a type mismatch", () => {
    const errors = validateInput(writeSchema, { path: 123 as unknown as string, content: "hi" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "typeMismatch", property: "path", expected: "string", actual: "number" });
  });

  it("accepts extra properties when additionalProperties is true", () => {
    const errors = validateInput(tools[1].parameters, { message: "x", extra: 1 });
    expect(errors).toEqual([]);
  });

  it("flags extra properties when additionalProperties is undefined (strict by default)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const errors = validateInput(schema, { a: "x", b: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "unknownProperty", property: "b" });
  });

  it("detects multiple errors at once", () => {
    const errors = validateInput(writeSchema, { filename: "a.txt", content: "hi" });
    // filename is unknown, path is missing (content present)
    expect(errors).toHaveLength(2);
    const kinds = errors.map((e) => e.kind).sort();
    expect(kinds).toEqual(["missingRequired", "unknownProperty"]);
  });

  it("validates integer vs number typing", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
      additionalProperties: false,
    };
    expect(validateInput(schema, { n: 3.5 })).toHaveLength(1);
    expect(validateInput(schema, { n: 3 })).toHaveLength(0);
  });
});

describe("classifyRecoverable", () => {
  it("returns non-recoverable for an unknown tool", () => {
    const c = classifyRecoverable("frobnicate", { x: 1 }, tools);
    expect(c.recoverable).toBe(false);
    expect(c.errors).toEqual([]);
    expect(c.tool).toBeUndefined();
  });

  it("returns non-recoverable for a clean call", () => {
    const c = classifyRecoverable("write", { path: "a.txt", content: "hi" }, tools);
    expect(c.recoverable).toBe(false);
    expect(c.tool?.name).toBe("write");
  });

  it("returns recoverable with errors for a bad call", () => {
    const c = classifyRecoverable("write", { filename: "a.txt", content: "hi" }, tools);
    expect(c.recoverable).toBe(true);
    expect(c.errors.some((e) => e.kind === "unknownProperty")).toBe(true);
  });
});

describe("formatSchemaErrors", () => {
  it("renders a readable line", () => {
    const c = classifyRecoverable("write", { filename: "a.txt", content: "hi" }, tools);
    const line = formatSchemaErrors(c.errors);
    expect(line).toContain("unknown property 'filename'");
    expect(line).toContain("missing required property 'path'");
  });

  it("handles the empty case", () => {
    expect(formatSchemaErrors([])).toBe("no schema errors");
  });
});
