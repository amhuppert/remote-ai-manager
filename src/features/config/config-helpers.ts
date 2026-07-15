import {
  getEffortLevelsForBackend,
  getModelsForBackend,
} from "@/lib/agent-backends/catalog";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
// ---------------------------------------------------------------------------
// Label formatting
// ---------------------------------------------------------------------------

const ACRONYMS = new Set(["url", "ttl", "id", "api", "ip", "css", "html"]);

/**
 * Converts a camelCase field name to a human-readable label.
 * Strips trailing "Ms" suffix (duration fields show units separately).
 */
export function formatFieldLabel(label: string): string {
  // Strip trailing "Ms" (milliseconds suffix)
  const cleaned = label.replace(/Ms$/, "");

  // Insert spaces: handle sequences like "preMerge" → "pre Merge"
  const spaced = cleaned
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  return spaced
    .split(" ")
    .map((word) => {
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// Duration conversion
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;

export function msToMinutes(ms: number): number {
  return ms / MS_PER_MINUTE;
}

export function minutesToMs(minutes: number): number {
  return minutes * MS_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// Numeric input validation
// ---------------------------------------------------------------------------

export interface NumericValidationOptions {
  required?: boolean;
  positive?: boolean;
  integer?: boolean;
}

export interface NumericValidationResult {
  valid: boolean;
  value?: number;
  error?: string;
}

export function validateNumericInput(
  input: string,
  options: NumericValidationOptions,
): NumericValidationResult {
  const trimmed = input.trim();

  if (trimmed === "") {
    if (options.required) {
      return { valid: false, error: "Required" };
    }
    return { valid: true, value: undefined };
  }

  const parsed = Number(trimmed);

  if (isNaN(parsed)) {
    return { valid: false, error: "Must be a number" };
  }

  if (options.positive && parsed <= 0) {
    return { valid: false, error: "Must be positive" };
  }

  if (options.integer && !Number.isInteger(parsed)) {
    return { valid: false, error: "Must be a whole number" };
  }

  return { valid: true, value: parsed };
}

// ---------------------------------------------------------------------------
// Backend-dependent option helpers
// ---------------------------------------------------------------------------

export function getModelOptionsForBackend(
  backend: AgentBackendId,
): readonly string[] {
  return getModelsForBackend(backend).map((m) => m.id);
}

export function getEffortOptionsForBackend(
  backend: AgentBackendId,
  model?: string,
): EffortLevel[] {
  return getEffortLevelsForBackend(backend, model);
}
