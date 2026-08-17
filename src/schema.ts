/**
 * Tool schema cache + validation.
 *
 * Pi exposes each tool's parameter schema via `pi.getAllTools()`. This module
 * validates a tool call's arguments against that schema and classifies the
 * recoverable error kinds the recovery LLM can fix:
 *
 *   - unknownProperty  an argument the tool does not accept (e.g. `filename`)
 *   - missingRequired  a required argument was omitted
 *   - typeMismatch     an argument has the wrong JSON type
 *
 * Everything here is a pure function so it can be unit-tested without a live
 * model or a running pi session.
 */

export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "null";

export interface JsonSchemaProperty {
  type?: JsonSchemaType | JsonSchemaType[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  optional?: boolean;
  description?: string;
  [key: string]: unknown;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  /** When `true`, extra properties are allowed and not flagged. Otherwise strict. */
  additionalProperties?: boolean | JsonSchemaProperty;
  [key: string]: unknown;
}

export type SchemaErrorKind = "unknownProperty" | "missingRequired" | "typeMismatch";

export interface SchemaError {
  kind: SchemaErrorKind;
  property: string;
  expected?: string;
  actual?: string;
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  if (type === "integer") {
    return actualType(value) === "number" && Number.isInteger(value as number);
  }
  return actualType(value) === type;
}

function checkProperty(
  property: string,
  value: unknown,
  propSchema: JsonSchemaProperty,
): SchemaError[] {
  const types = Array.isArray(propSchema.type)
    ? propSchema.type
    : propSchema.type
      ? [propSchema.type]
      : [];

  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    return [
      {
        kind: "typeMismatch",
        property,
        expected: types.join(" | "),
        actual: actualType(value),
      },
    ];
  }

  if (
    propSchema.properties &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return validateShape(propSchema as unknown as JsonSchema, value as Record<string, unknown>);
  }

  if (propSchema.items && Array.isArray(value)) {
    const out: SchemaError[] = [];
    const itemSchema = propSchema.items;
    for (const item of value) {
      out.push(...checkProperty(`${property}[]`, item, itemSchema));
    }
    return out;
  }

  return [];
}

export function validateShape(schema: JsonSchema, input: Record<string, unknown>): SchemaError[] {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const strict = schema.additionalProperties !== true;
  const errors: SchemaError[] = [];

  for (const key of Object.keys(input)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      errors.push(...checkProperty(key, input[key], properties[key]));
    } else if (strict) {
      errors.push({ kind: "unknownProperty", property: key });
    }
  }

  for (const key of required) {
    if (!(key in input) || input[key] === undefined) {
      errors.push({ kind: "missingRequired", property: key });
    }
  }

  return errors;
}

/** Validate a tool call's arguments against the tool's parameter schema. */
export function validateInput(schema: JsonSchema, input: Record<string, unknown>): SchemaError[] {
  return validateShape(schema, input);
}

export interface ToolDescriptor {
  name: string;
  parameters: JsonSchema;
}

export interface Classification {
  /** True when the call failed schema validation and the error is recoverable. */
  recoverable: boolean;
  errors: SchemaError[];
  tool?: ToolDescriptor;
}

/**
 * Find the named tool and classify its call. Returns `recoverable: false` with
 * no errors when the tool is unknown (we cannot recover an unknown tool here).
 */
export function classifyRecoverable(
  toolName: string,
  input: Record<string, unknown>,
  tools: ToolDescriptor[],
): Classification {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) return { recoverable: false, errors: [] };
  const errors = validateInput(tool.parameters, input);
  return { recoverable: errors.length > 0, errors, tool };
}

/** Render schema errors into a single line for the recovery prompt. */
export function formatSchemaErrors(errors: SchemaError[]): string {
  if (errors.length === 0) return "no schema errors";
  return errors
    .map((e) => {
      switch (e.kind) {
        case "unknownProperty":
          return `unknown property '${e.property}'`;
        case "missingRequired":
          return `missing required property '${e.property}'`;
        case "typeMismatch":
          return `property '${e.property}' has wrong type: expected ${e.expected}, got ${e.actual}`;
      }
    })
    .join("; ");
}
