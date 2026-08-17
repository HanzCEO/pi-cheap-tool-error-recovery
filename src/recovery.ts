/**
 * Recovery model client.
 *
 * Talks to a separately chosen "recovery" LLM. The recovery model receives the
 * session's available tool list, the failing tool call, and the validation
 * error, then returns a corrected call as JSON:
 *
 *   { "toolName": "write", "args": { "path": "abc.txt", "content": "..." } }
 *
 * Pure pieces (prompt building, response parsing, request shaping) are kept
 * separate so they can be unit-tested without a network or a live model. The
 * `callRecoveryModel` wrapper performs the actual `fetch`.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { JsonSchema } from "./schema";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RecoveryToolSpec {
  name: string;
  description?: string;
  parameters: JsonSchema;
}

export interface BadCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** What `/toolrecovery-model` persists and what we resolve auth from. */
export interface RecoverySelection {
  provider: string;
  id: string;
}

/** Everything `callRecoveryModel` needs to hit the provider's chat endpoint. */
export interface RecoveryTarget {
  api: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  modelId: string;
}

export interface RecoveredCall {
  toolName: string;
  args: Record<string, unknown>;
}

export class RecoveryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryParseError";
  }
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const SYSTEM_PROMPT = [
  "You repair broken tool calls made by an AI coding assistant.",
  "You are given the list of tools the assistant is allowed to use and the",
  "parameters each one accepts. You are also given one tool call that failed",
  "validation and the reason it failed.",
  "Your only job is to return the corrected tool call as a single JSON object.",
  "Keep the same tool unless a different tool is clearly intended, and match",
  "the tool's parameter names exactly. Do not explain. Do not add fields the",
  "tool does not accept.",
].join(" ");

export function buildRecoveryMessages(
  tools: RecoveryToolSpec[],
  badCall: BadCall,
  errorText: string,
): ChatMessage[] {
  const toolList = tools
    .map((t) => {
      const params = JSON.stringify(t.parameters ?? {});
      const desc = t.description ? ` ${t.description}` : "";
      return `- ${t.name}:${desc}\n  parameters: ${params}`;
    })
    .join("\n");

  const system =
    `${SYSTEM_PROMPT}\n\nAvailable tools:\n${toolList}\n\n` +
    `Respond with JSON only: {"toolName": string, "args": object}.`;

  const user =
    `The assistant called tool "${badCall.toolName}" with arguments:\n` +
    `${JSON.stringify(badCall.input, null, 2)}\n\n` +
    `This failed validation with:\n${errorText}\n\n` +
    `Return the corrected call as JSON.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function parseRecoveryResponse(raw: string): RecoveredCall {
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
    text = text.slice(braceStart, braceEnd + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RecoveryParseError("recovery model did not return valid JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).toolName !== "string" ||
    typeof (parsed as Record<string, unknown>).args !== "object" ||
    (parsed as Record<string, unknown>).args === null ||
    Array.isArray((parsed as Record<string, unknown>).args)
  ) {
    throw new RecoveryParseError("recovery JSON missing a valid toolName/args");
  }

  return {
    toolName: (parsed as { toolName: string }).toolName,
    args: (parsed as { args: Record<string, unknown> }).args,
  };
}

export function extractContentFromResponse(api: string, json: unknown): string {
  const obj = json as Record<string, unknown>;

  if (api === "anthropic-messages") {
    const content = obj?.content;
    if (Array.isArray(content)) {
      return content
        .filter((b) => (b as Record<string, unknown>)?.type === "text" && typeof (b as Record<string, unknown>).text === "string")
        .map((b) => (b as Record<string, unknown>).text as string)
        .join("\n");
    }
    if (typeof content === "string") return content;
    throw new RecoveryParseError("unexpected anthropic response shape");
  }

  const choices = (obj?.choices as unknown[]) ?? [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === "string") return message.content;
  throw new RecoveryParseError("unexpected openai response shape");
}

function pathForApi(api: string): string {
  if (api === "anthropic-messages") return "/v1/messages";
  return "/chat/completions";
}

function normalizeBaseUrl(base: string): string {
  return base.replace(/\/+$/, "");
}

export function buildRequest(
  target: RecoveryTarget,
  messages: ChatMessage[],
): { url: string; headers: Record<string, string>; body: unknown } {
  const url = normalizeBaseUrl(target.baseUrl) + pathForApi(target.api);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(target.headers ?? {}),
  };

  if (target.api === "anthropic-messages") {
    if (target.apiKey) headers["x-api-key"] = target.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const chat = messages.filter((m) => m.role !== "system");
    return {
      url,
      headers,
      body: { model: target.modelId, max_tokens: 1024, system, messages: chat },
    };
  }

  if (target.apiKey) headers["authorization"] = `Bearer ${target.apiKey}`;
  return {
    url,
    headers,
    body: { model: target.modelId, max_tokens: 1024, messages },
  };
}

/**
 * Resolve a stored selection into a concrete request target. Returns null when
 * the provider has no configured auth or no base URL.
 */
export async function resolveRecoveryTarget(
  modelRegistry: ModelRegistry,
  selection: RecoverySelection,
): Promise<RecoveryTarget | null> {
  const auth = await modelRegistry.getProviderAuth(selection.provider);
  if (!auth) return null;

  const model = modelRegistry.find(selection.provider, selection.id);
  const provider = modelRegistry.getProvider(selection.provider);
  const api =
    (model?.api as string | undefined) ?? "openai-completions";
  const baseUrl =
    model?.baseUrl ?? auth.auth.baseUrl ?? (provider?.baseUrl as string | undefined) ?? "";
  if (!baseUrl) return null;

  const headers: Record<string, string> = {};
  const sourceHeaders = auth.auth.headers as Record<string, string | undefined> | undefined;
  if (sourceHeaders) {
    for (const [k, v] of Object.entries(sourceHeaders)) {
      if (v != null) headers[k] = String(v);
    }
  }

  return {
    api,
    baseUrl,
    apiKey: auth.auth.apiKey,
    headers: Object.keys(headers).length ? headers : undefined,
    modelId: selection.id,
  };
}

export function directRecoveryTarget(
  baseUrl: string,
  apiKey?: string,
  modelId = "recovery",
): RecoveryTarget {
  return { api: "openai-completions", baseUrl: normalizeBaseUrl(baseUrl), apiKey, modelId };
}

export async function callRecoveryModel(
  target: RecoveryTarget,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<RecoveredCall> {
  const { url, headers, body } = buildRequest(target, messages);

  const timeout = opts.timeoutMs ?? 20000;
  const signal: AbortSignal =
    opts.signal && typeof (AbortSignal as unknown as { any?: unknown }).any === "function"
      ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([
          opts.signal,
          AbortSignal.timeout(timeout),
        ])
      : AbortSignal.timeout(timeout);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`recovery model request failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const raw = extractContentFromResponse(target.api, json);
  return parseRecoveryResponse(raw);
}
