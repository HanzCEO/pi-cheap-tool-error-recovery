# pi-cheap-tool-error-recovery

A pi.dev extension that recovers your tool-call errors cheaply, before they reach the assistant.

When the assistant emits a tool call whose arguments do not match the tool's schema, the extension intercepts the call before it runs, asks a separately selectable recovery LLM for a corrected call, patches the arguments, and lets the corrected tool run for real. The assistant only ever sees the corrected result, never the original error.

The canonical case is a parameter-name slip. The assistant sends `write(filename="abc.txt", content="hello world")` but the `write` tool expects `path` and `content`, not `filename`. The extension turns that into `write(path="abc.txt", content="hello world")` and the file is written.

## Features

- Intercepts schema-invalid tool calls before validation and execution, so the assistant never sees the raw error.
- Routes the available tool list, the failing call, and the validation error to a recovery LLM.
- Patches the arguments with the correction, but only after re-validating it against the tool's schema.
- Lets the corrected tool run for real, so the assistant sees the corrected result.
- Uses a recovery LLM you choose separately from your main model (a pi provider picker or any OpenAI-compatible endpoint, including local models).
- Stays safe: it honors cancellation, enforces a timeout, and falls through to the original error if recovery fails.

## Why interception happens at `message_end`, not `tool_call`

This matters and is easy to get wrong. In the pi runtime, a tool call is validated before the `tool_call` event fires. In `prepareToolCall` (inside `@earendil-works/pi-agent-core`), `validateToolArguments` runs inside a `try`, and `beforeToolCall` (which emits `tool_call`) runs only after validation succeeds. A schema-invalid call throws during that validation, produces an immediate error result, and the `tool_call` event never fires for it.

So a pre-execution patch at `tool_call` is impossible for the exact case this extension exists to fix. The earliest extension hook that still runs before validation and execution, and that fires even for invalid calls, is `message_end`. It emits as the assistant message is finalized, before pi validates or executes any tool calls. The handler rewrites the tool-call arguments on that message, and pi then validates the corrected call (which now passes) and executes it. That is the mechanism this extension uses.

## Install

Run directly while developing:

```bash
cd pi-cheap-tool-error-recovery
npm install
npm run build            # optional; pi can load .ts directly
pi -e ./src/index.ts
```

Install as a project or user extension by adding the package to your pi extensions config. In `package.json`, declare a `pi.extensions` entry pointing at the `default` export that calls `pi.registerExtension`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Then choose a recovery model as described below.

## Choose the recovery LLM

Two ways to point the extension at a recovery model.

1. pi-registered provider, via the picker. Run `/toolrecovery-model`; it opens a TUI picker of the providers pi knows about. The selection is saved in your user-global config at `~/.pi/agent/tool-recovery.json` and persists across projects. In non-interactive or print mode the picker is unavailable and prints a hint, because a live selection requires an interactive terminal.
2. Any OpenAI-compatible endpoint, including local models and proxies. Set the environment variables:

   ```bash
   export TOOLRECOVERY_BASE_URL="http://127.0.0.1:11434/v1"   # OpenAI-compatible base URL
   export TOOLRECOVERY_API_KEY=""                              # optional; omitted for local models
   export TOOLRECOVERY_MODEL_ID="your-model"                  # optional; defaults to "recovery"
   ```

When `TOOLRECOVERY_BASE_URL` is set, it takes precedence over the picker selection, so no pi provider is required. This is how you run a local model (Ollama, LM Studio, and so on) or a proxy as the recovery LLM.

The recovery client targets two API shapes: the Anthropic Messages API and the OpenAI-compatible Chat Completions API. A Google-only pi configuration therefore needs a Google to OpenAI-compatible proxy, or an Anthropic or OpenAI key, to act as the recovery model.

## Commands

| Command | Effect |
| --- | --- |
| `/toolrecovery-model` | Open the picker to choose the recovery LLM (TUI only). |
| `/toolrecovery on` | Enable recovery. |
| `/toolrecovery off` | Disable recovery. |
| `/toolrecovery status` | Show whether recovery is enabled and which model is selected. |

Recovery defaults to on. When it is disabled, or when no recovery model is configured, every call passes through untouched and the extension changes nothing.

## How a recovery works

1. At `message_end`, for each assistant `toolCall` block, the handler validates the arguments against the tool's schema (from `pi.getAllTools()`).
2. If the call is invalid, it builds a prompt containing the available tool list, the failing call, and the validation error, and sends it to the recovery LLM.
3. The recovery LLM returns the corrected call as JSON: `{ "toolName": "...", "args": { ... } }`.
4. The handler re-validates the corrected call against the (possibly different) tool's schema. Only if it is valid is the tool-call block rewritten. Otherwise the original invalid call is left in place, so the real error surfaces to the assistant instead of being silently swallowed.
5. pi validates and executes the corrected call, and the assistant sees the corrected result.

## Safety

Recovery honors `ctx.signal` and enforces a 20-second timeout. If the recovery model is unreachable, times out, or returns something that still fails validation, the extension falls through and leaves the original call alone, so the normal error is shown. The assistant's message is mutated only when the correction is itself valid.

`message_end` re-emits after a handler returns a replacement, so the handler is idempotent. It re-validates on each pass and only mutates blocks that are still invalid. Once a block is corrected it becomes valid and is left alone on the next pass.

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `TOOLRECOVERY_BASE_URL` | OpenAI-compatible base URL for the recovery model. Takes precedence over the picker. | unset |
| `TOOLRECOVERY_API_KEY` | API key for that endpoint. Omit for local models. | unset |
| `TOOLRECOVERY_MODEL_ID` | Model id sent to that endpoint. | `recovery` |

The enable flag and the picker selection live in `~/.pi/agent/tool-recovery.json`.

## Limitations and caveats

- The extension works on the assistant's literal tool-call arguments as emitted. It cannot reconstruct intent the model never expressed. If the slip is not recoverable from the arguments, the schema, and the error text, recovery returns nothing useful and the call falls through to its normal error.
- A tool's TypeBox parameters are re-derived into a JSON-schema-like view (required, type, properties, enum). For the canonical case and common schemas this matches pi's own validation. Exotic TypeBox features could in principle diverge, but the re-validation gate in `planBlockRecovery` protects against applying a correction that pi would still reject.
- A Google-only pi configuration needs a Google to OpenAI-compatible proxy, or an Anthropic or OpenAI key, because the recovery client targets the Anthropic Messages API and the OpenAI Chat Completions API.

## Develop

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest unit + integration tests
npm run e2e          # reproducible live proof (see below)
```

The pure logic (schema validation, prompt building, response parsing, the apply decision) is unit-tested without a live model. The end-to-end path (intercept, recover, rewrite, real execution) is proven by `npm run e2e`, which is fully reproducible: it starts a mock OpenAI-compatible server as the recovery LLM, runs pi with a harness that imports the real shipped modules, and force-injects a schema-invalid `write(filename=...)` call. The harness asserts that the extension's proof log shows the correction applied (`filename` to `path`), and the mock server's request log confirms a real recovery fetch happened. Run it with:

```bash
npm run e2e
```

## Layout

- `src/schema.ts` — turn a tool's TypeBox parameters into a JSON-schema-like shape and validate a call's arguments; classify recoverable versus clean.
- `src/recovery.ts` — build the recovery prompt, resolve the provider and auth, call the recovery LLM (Anthropic and OpenAI-compatible), and parse the `{toolName, args}` response.
- `src/handler.ts` — the pure apply decision (`planBlockRecovery`).
- `src/config.ts` — persisted enable flag and model selection, plus the direct endpoint environment overrides.
- `src/picker.ts` — TUI model picker for `/toolrecovery-model`.
- `src/index.ts` — the `message_end` interceptor and the two commands.
- `test/` — unit and integration tests, plus the e2e harness.
- `scripts/e2e.sh` — the reproducible live proof.

## License

Apache License 2.0. See `LICENSE`.
