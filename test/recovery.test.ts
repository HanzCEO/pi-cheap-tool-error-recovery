import { describe, it, expect } from "vitest";
import {
  buildRecoveryMessages,
  parseRecoveryResponse,
  extractContentFromResponse,
  buildRequest,
  RecoveryParseError,
  type RecoveryToolSpec,
  type BadCall,
} from "../src/recovery";

const tools: RecoveryToolSpec[] = [
  {
    name: "write",
    description: "Write a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

const badCall: BadCall = {
  toolName: "write",
  input: { filename: "abc.txt", content: "hello world" },
};

describe("buildRecoveryMessages", () => {
  it("includes the tool list, the bad call, and the error", () => {
    const msgs = buildRecoveryMessages(tools, badCall, "unknown property 'filename'");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");

    const all = msgs.map((m) => m.content).join("\n");
    expect(all).toContain("write");
    expect(all).toContain('"filename": "abc.txt"');
    expect(all).toContain("unknown property 'filename'");
    expect(all).toContain('"toolName"');
  });
});

describe("parseRecoveryResponse", () => {
  it("parses a bare JSON object", () => {
    const r = parseRecoveryResponse('{"toolName":"write","args":{"path":"abc.txt","content":"hello world"}}');
    expect(r).toEqual({ toolName: "write", args: { path: "abc.txt", content: "hello world" } });
  });

  it("strips a code fence", () => {
    const r = parseRecoveryResponse('```json\n{"toolName":"write","args":{"path":"x"}}\n```');
    expect(r.toolName).toBe("write");
  });

  it("extracts JSON embedded in prose", () => {
    const r = parseRecoveryResponse('Sure! {"toolName":"write","args":{"path":"x"}} done.');
    expect(r.toolName).toBe("write");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseRecoveryResponse("not json at all")).toThrow(RecoveryParseError);
  });

  it("throws when args is missing", () => {
    expect(() => parseRecoveryResponse('{"toolName":"write"}')).toThrow(RecoveryParseError);
  });

  it("throws when toolName is not a string", () => {
    expect(() => parseRecoveryResponse('{"toolName":5,"args":{}}')).toThrow(RecoveryParseError);
  });
});

describe("extractContentFromResponse", () => {
  it("reads anthropic content blocks", () => {
    const json = { content: [{ type: "text", text: '{"toolName":"write","args":{}}' }] };
    expect(extractContentFromResponse("anthropic-messages", json)).toBe('{"toolName":"write","args":{}}');
  });

  it("reads openai choices", () => {
    const json = { choices: [{ message: { content: '{"toolName":"write","args":{}}' } }] };
    expect(extractContentFromResponse("openai-completions", json)).toBe('{"toolName":"write","args":{}}');
  });

  it("throws on unexpected anthropic shape", () => {
    expect(() => extractContentFromResponse("anthropic-messages", {})).toThrow(RecoveryParseError);
  });
});

describe("buildRequest", () => {
  const messages = buildRecoveryMessages(tools, badCall, "err");

  it("builds an anthropic messages request with system separated", () => {
    const target = { api: "anthropic-messages", baseUrl: "https://api.anthropic.com/", apiKey: "k", modelId: "claude-x" };
    const req = buildRequest(target, messages);
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("k");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    const body = req.body as { system: string; messages: unknown[] };
    expect(body.system).toContain("write");
    expect(body.messages).toHaveLength(1);
    expect((body.messages[0] as { role: string }).role).toBe("user");
  });

  it("builds an openai chat request with bearer auth", () => {
    const target = { api: "openai-completions", baseUrl: "https://api.openai.com/v1", apiKey: "k", modelId: "gpt-x" };
    const req = buildRequest(target, messages);
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers["authorization"]).toBe("Bearer k");
    const body = req.body as { model: string; messages: unknown[] };
    expect(body.model).toBe("gpt-x");
    expect(body.messages).toHaveLength(2);
  });

  it("merges provider headers", () => {
    const target = { api: "openai-completions", baseUrl: "https://x/v1", headers: { "x-custom": "yes" }, modelId: "m" };
    const req = buildRequest(target, messages);
    expect(req.headers["x-custom"]).toBe("yes");
  });
});
