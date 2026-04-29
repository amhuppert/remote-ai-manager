/**
 * Shared structured-output validation gate for the AgentCall primitive.
 *
 * Runs after dispatch on both backends — even when a backend (e.g. Codex)
 * natively enforces the schema during generation — so the workflow layer
 * always sees a single normalized validation outcome regardless of where
 * enforcement happens.
 *
 * The validator is injected: production wires in a Zod- or AJV-backed
 * validator, tests inject a stub. The gate never throws — a thrown
 * validator turns into a `fail` outcome with a normalized reason.
 *
 * Output is a shared `GateResult` from the gate vocabulary so workflow
 * authors can treat structured-output validation identically to other
 * gate kinds (script validation, change-set, convergence, etc.).
 */

import { createLogger } from "@/lib/logging";
import {
  gateFail,
  gatePass,
  type GateFailResult,
  type GatePassResult,
} from "./gate-vocabulary";

const logger = createLogger("workflows.primitives.structured-output-gate");

export interface StructuredOutputValidator {
  (
    schema: Record<string, unknown>,
    value: unknown,
  ): { valid: boolean; errors?: string[] };
}

export type StructuredOutputGateResult = GatePassResult | GateFailResult;

export function validateJsonSchemaSubset(
  schema: Record<string, unknown>,
  value: unknown,
): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];
  validateAgainstSchema(schema, value, "$", errors);
  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

export function runStructuredOutputGate(
  schema: Record<string, unknown>,
  value: unknown,
  validator: StructuredOutputValidator,
): StructuredOutputGateResult {
  let outcome: { valid: boolean; errors?: string[] };
  try {
    outcome = validator(schema, value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("structured_output_gate.validator_threw", { message });
    return gateFail({
      kind: "structured_output",
      reason: `structured-output validator threw: ${message}`,
      details: { errors: [] },
    });
  }
  if (outcome.valid) {
    return gatePass({ kind: "structured_output" });
  }
  const errors = outcome.errors ?? [];
  const reason =
    errors.length > 0
      ? `structured output failed validation: ${errors.join("; ")}`
      : "structured output failed validation";
  return gateFail({
    kind: "structured_output",
    reason,
    details: { errors },
  });
}

function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (value !== schema.const) {
      errors.push(`${path} must equal ${String(schema.const)}`);
    }
    return;
  }

  const type = schema.type;
  if (type !== undefined && !matchesJsonSchemaType(value, type)) {
    errors.push(`${path} must be ${describeJsonSchemaType(type)}`);
    return;
  }

  if (type === "object" || hasObjectShape(schema)) {
    validateObjectSchema(schema, value, path, errors);
    return;
  }

  if (type === "array") {
    validateArraySchema(schema, value, path, errors);
    return;
  }

  if (type === "string") {
    validateStringSchema(schema, value, path, errors);
    return;
  }

  if (type === "number" || type === "integer") {
    validateNumberSchema(schema, value, path, errors);
  }
}

function hasObjectShape(schema: Record<string, unknown>): boolean {
  return (
    typeof schema.properties === "object" ||
    Array.isArray(schema.required) ||
    schema.additionalProperties === false
  );
}

function matchesJsonSchemaType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type))
    return type.some((t) => matchesJsonSchemaType(value, t));
  switch (type) {
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describeJsonSchemaType(type: unknown): string {
  return Array.isArray(type) ? type.map(String).join(" or ") : String(type);
}

function validateObjectSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${path} must be object`);
    return;
  }

  const objectValue = value as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in objectValue)) {
      errors.push(`${path}.${key} is required`);
    }
  }

  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(objectValue)) {
      if (!allowed.has(key)) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    if (!(key in objectValue)) continue;
    if (typeof childSchema !== "object" || childSchema === null) continue;
    validateAgainstSchema(
      childSchema as Record<string, unknown>,
      objectValue[key],
      `${path}.${key}`,
      errors,
    );
  }
}

function validateArraySchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be array`);
    return;
  }

  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push(`${path} must contain at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push(`${path} must contain at most ${schema.maxItems} items`);
  }

  if (typeof schema.items !== "object" || schema.items === null) return;
  for (let i = 0; i < value.length; i += 1) {
    validateAgainstSchema(
      schema.items as Record<string, unknown>,
      value[i],
      `${path}[${i}]`,
      errors,
    );
  }
}

function validateStringSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value !== "string") return;
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path} must be at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push(`${path} must be at most ${schema.maxLength} characters`);
  }
  if (typeof schema.pattern === "string") {
    const pattern = new RegExp(schema.pattern);
    if (!pattern.test(value)) {
      errors.push(`${path} must match pattern ${schema.pattern}`);
    }
  }
}

function validateNumberSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value !== "number") return;
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push(`${path} must be <= ${schema.maximum}`);
  }
}
