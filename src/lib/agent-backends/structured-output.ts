/**
 * Shared structured-output extraction and post-parse validation for agent
 * turns across all backends.
 *
 * Extraction precedence is native → raw JSON of the full text → the last
 * fenced JSON block. Validation tries each extracted candidate in that order
 * and accepts the first one that passes the Zod schema (fall-through), so a
 * backend-native payload that fails the contract does not mask a valid
 * self-corrected fenced payload later in the same turn. Zod remains the
 * authoritative acceptance schema; model-facing wire projection is
 * backend-owned (see `claude/structured-output-projection.ts`).
 */

import { z } from "zod";
import { createLogger } from "@/lib/logging";

const logger = createLogger("agent-backends.structured-output");

// Guardrail tests outside the backend seam import Claude's keyword-hazard
// helpers through this neutral surface; deep agent-backends/claude/** imports
// are fenced by the backend-deep-imports seam rule.
export {
  UNSUPPORTED_CLAUDE_STRUCTURED_OUTPUT_KEYWORDS,
  unsupportedStructuredOutputKeywordPaths,
} from "./claude/structured-output-projection";

export type StructuredOutputSource = "native" | "raw_json" | "fenced";

export interface ExtractStructuredOutputOptions {
  /**
   * Restrict fenced extraction to a named info string (e.g. "spawn-proposal").
   * Default: last ```json or bare ``` fence.
   */
  fenceInfo?: string;
}

export interface StructuredOutputInput {
  native?: unknown;
  text: string | null;
}

export interface StructuredOutputCandidate {
  value: unknown;
  source: StructuredOutputSource;
}

export type ExtractStructuredOutputResult =
  | { ok: true; value: unknown; source: StructuredOutputSource }
  | { ok: false; error: string };

export type ValidateStructuredOutputResult<T> =
  | { ok: true; value: T; source: StructuredOutputSource }
  | { ok: false; error: string; stage: "extraction" | "validation" };

/**
 * Returns every extractable candidate in precedence order. Callers that
 * validate with a non-Zod mechanism (e.g. the AgentCall facade's JSON-schema
 * gate) iterate this list to get the same fall-through semantics as
 * {@link validateStructuredOutput}.
 */
export function extractStructuredOutputCandidates(
  input: StructuredOutputInput,
  options?: ExtractStructuredOutputOptions,
): StructuredOutputCandidate[] {
  const candidates: StructuredOutputCandidate[] = [];
  if (input.native !== undefined) {
    candidates.push({ value: input.native, source: "native" });
  }
  if (input.text !== null && input.text.length > 0) {
    const raw = tryParseJson(input.text);
    if (raw.found) {
      candidates.push({ value: raw.value, source: "raw_json" });
    }
    const fenced = extractLastFence(input.text, options?.fenceInfo);
    if (fenced !== null) {
      const parsed = tryParseJson(fenced);
      if (parsed.found) {
        candidates.push({ value: parsed.value, source: "fenced" });
      }
    }
  }
  return candidates;
}

export function extractStructuredOutput(
  input: StructuredOutputInput,
  options?: ExtractStructuredOutputOptions,
): ExtractStructuredOutputResult {
  const candidates = extractStructuredOutputCandidates(input, options);
  const first = candidates[0];
  if (first !== undefined) {
    logger.debug("structured_output.extracted", { source: first.source });
    return { ok: true, value: first.value, source: first.source };
  }
  const error = describeExtractionFailure(input, options);
  logger.warn("structured_output.validation_failed", {
    stage: "extraction",
    error,
  });
  return { ok: false, error };
}

/**
 * Validates the extracted candidates against `schema` in precedence order and
 * accepts the first that passes. When every candidate fails, the reported
 * issues are the highest-priority candidate's, since that is the payload the
 * backend intended as the answer.
 */
export function validateStructuredOutput<T>(
  schema: z.ZodType<T>,
  input: StructuredOutputInput,
  options?: ExtractStructuredOutputOptions,
): ValidateStructuredOutputResult<T> {
  const candidates = extractStructuredOutputCandidates(input, options);
  if (candidates.length === 0) {
    const error = describeExtractionFailure(input, options);
    logger.warn("structured_output.validation_failed", {
      stage: "extraction",
      error,
    });
    return { ok: false, error, stage: "extraction" };
  }

  let firstFailure: {
    source: StructuredOutputSource;
    issues: z.core.$ZodIssue[];
  } | null = null;
  for (const candidate of candidates) {
    const parsed = schema.safeParse(candidate.value);
    if (parsed.success) {
      logger.debug("structured_output.extracted", { source: candidate.source });
      return { ok: true, value: parsed.data, source: candidate.source };
    }
    firstFailure ??= { source: candidate.source, issues: parsed.error.issues };
  }

  if (firstFailure === null) {
    // Unreachable: candidates.length > 0 guarantees a recorded failure.
    const error = describeExtractionFailure(input, options);
    return { ok: false, error, stage: "extraction" };
  }

  const failure = firstFailure;
  const issuePaths = failure.issues.map((issue) => issue.path.join(".") || "$");
  const error = `structured output failed validation (${failure.source} candidate): ${failure.issues
    .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
    .join("; ")}`;
  logger.warn("structured_output.validation_failed", {
    stage: "validation",
    source: failure.source,
    issuePaths,
  });
  return { ok: false, error, stage: "validation" };
}

function describeExtractionFailure(
  input: StructuredOutputInput,
  options?: ExtractStructuredOutputOptions,
): string {
  const fenceLabel = options?.fenceInfo
    ? `no fenced ${options.fenceInfo} block`
    : "no fenced JSON block";
  const parts: string[] = ["native absent"];
  if (input.text === null || input.text.length === 0) {
    parts.push("text absent");
  } else {
    parts.push("text is not JSON", fenceLabel);
  }
  return `no structured output: ${parts.join(", ")}`;
}

function tryParseJson(
  text: string,
): { found: true; value: unknown } | { found: false } {
  try {
    return { found: true, value: JSON.parse(text) };
  } catch {
    return { found: false };
  }
}

function extractLastFence(text: string, fenceInfo?: string): string | null {
  const info = fenceInfo ? escapeRegExp(fenceInfo) : "(?:json)?";
  const pattern = new RegExp("```" + info + "\\s*\\n([\\s\\S]*?)```", "g");
  const matches = [...text.matchAll(pattern)];
  const last = matches.at(-1);
  return last?.[1]?.trim() ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
