/**
 * Runtime capability hashing + apply-state seeding.
 *
 * Conversation-start composition emits one runtime capability config per
 * backend-owned cascade. The apply service compares `pendingHash` to
 * `appliedHash` to decide whether work is required. Those hashes must be:
 *
 *   - **Stable** — input-order-independent so the same effective state
 *     always produces the same hash regardless of how the rows arrived.
 *   - **Scoped to the emitted payload** — different from the resolver's view
 *     hash (which includes stale rows for display). A row that is not
 *     runtime-emittable does not contribute to the runtime hash because it
 *     is not part of what the backend actually receives.
 *
 * The composer collects each emitted cascade's `(itemId, enabled)` projection
 * and feeds it to `computeCascadeRuntimeHash`. The seed helper then converts
 * those hashes into the initial `AgentCapabilityRuntimeApplicationState`
 * stored on a new conversation runtime so the apply service can transition
 * each cascade through `staged-* → applied` or `rejected` without losing the
 * previously-applied hash on failure.
 */

import { createHash } from "node:crypto";

import type {
  AgentCapabilityApplyStatus,
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeRuntimeState,
  AgentCapabilityRuntimeApplicationState,
} from "@/lib/schemas";

import { redactAgentCapabilityText } from "./redaction";

export interface RuntimeHashRow {
  itemId: string;
  enabled: boolean;
}

/**
 * Deterministic hash of a single cascade's emitted runtime payload.
 *
 * Input rows are sorted by `itemId` before hashing so the caller may pass
 * them in any order (the resolver already sorts, but downstream translators
 * may filter and re-build). The cascade kind is included as a salt so two
 * cascades with coincidentally identical item ids produce different hashes.
 */
export function computeCascadeRuntimeHash(input: {
  cascadeKind: AgentCapabilityCascadeKind;
  rows: readonly RuntimeHashRow[];
}): string {
  const sorted = [...input.rows].sort((a, b) =>
    a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
  );
  const parts: string[] = [`cascade:${input.cascadeKind}`];
  for (const row of sorted) {
    parts.push(`${row.itemId}|${row.enabled ? "1" : "0"}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export interface SeededCascade {
  cascadeKind: AgentCapabilityCascadeKind;
  /**
   * Hash of the freshly-composed runtime payload for this cascade. The apply
   * service promotes this to `appliedHash` once the backend confirms apply,
   * or leaves it as `pendingHash` while staged.
   */
  pendingHash: string;
  /**
   * Item ids included in the pending payload. Used by the apply service to
   * scope per-item retry diagnostics and to keep the row-level apply status
   * derivation in the resolver focused on the rows that were actually part
   * of the attempt.
   */
  pendingItemIds: readonly string[];
  /**
   * Apply disposition the composer determined for this cascade. For example,
   * Claude conversation-start composition seeds `staged-next-turn` (the SDK
   * receives the config at session creation but the apply service confirms
   * after the first turn). Codex always seeds `staged-next-turn`.
   */
  lastApplyStatus: AgentCapabilityApplyStatus;
}

/**
 * Seed `AgentCapabilityRuntimeApplicationState` for a brand-new conversation
 * runtime. Each cascade the composer emitted gets a record with the pending
 * hash + status; cascades that did not emit (verification-gated, unavailable,
 * discovery-failed) are omitted entirely so the apply service does not later
 * mistake them for stale pending work.
 */
export function seedRuntimeApplicationState(
  cascades: readonly SeededCascade[],
): AgentCapabilityRuntimeApplicationState {
  const out: AgentCapabilityRuntimeApplicationState = { cascades: {} };
  for (const cascade of cascades) {
    out.cascades[cascade.cascadeKind] = {
      pendingHash: cascade.pendingHash,
      pendingItemIds: [...cascade.pendingItemIds],
      lastApplyStatus: cascade.lastApplyStatus,
    };
  }
  return out;
}

export interface RecordApplyOutcomeInput {
  previous: AgentCapabilityCascadeRuntimeState | undefined;
  /** Hash of the payload the apply service attempted. */
  attemptedHash: string;
  /** Items that were part of the attempted payload. */
  attemptedItemIds: readonly string[];
  outcome:
    | { status: "applied" }
    | {
        status:
          | "staged-idle"
          | "staged-next-turn"
          | "deferred-next-conversation"
          | "rejected";
        error?: string;
      };
}

/**
 * Update one cascade's runtime state after an apply attempt without losing
 * the previously-applied hash on failure.
 *
 *   - On `applied`: promotes `attemptedHash` to `appliedHash`, clears the
 *     pending fields, and records the success status.
 *   - On a staged status: keeps the pending hash + items so the apply service
 *     can retry later, but records the staged status.
 *   - On `rejected`: keeps the previous `appliedHash` (so the UI/apply
 *     service still know the backend is on the last known-good payload),
 *     keeps the pending hash + items, and records the sanitized error.
 */
export function recordApplyOutcome(
  input: RecordApplyOutcomeInput,
): AgentCapabilityCascadeRuntimeState {
  const previousApplied = input.previous?.appliedHash;
  if (input.outcome.status === "applied") {
    return {
      appliedHash: input.attemptedHash,
      lastApplyStatus: "applied",
    };
  }
  const next: AgentCapabilityCascadeRuntimeState = {
    pendingHash: input.attemptedHash,
    pendingItemIds: [...input.attemptedItemIds],
    lastApplyStatus: input.outcome.status,
  };
  if (previousApplied !== undefined) {
    next.appliedHash = previousApplied;
  }
  if (
    input.outcome.status === "rejected" &&
    input.outcome.error !== undefined
  ) {
    next.lastApplyError = sanitizeApplyError(input.outcome.error);
  }
  return next;
}

/**
 * Strip absolute filesystem paths, stack frames, and likely secrets from an
 * apply error before storing it. The runtime state surface is read by the
 * UI and SSE consumers, so the message must be safe to render without
 * leaking the operator's home directory or environment values.
 */
export function sanitizeApplyError(raw: string): string {
  // Trim and collapse whitespace so long stack-trace lines do not blow up
  // diagnostic envelopes.
  let trimmed = redactAgentCapabilityText(raw.replace(/\s+/g, " ").trim());
  // Strip POSIX home-directory prefixes and absolute paths so the
  // diagnostic does not echo the operator's filesystem layout.
  trimmed = trimmed.replace(/\/(?:Users|home)\/[^\s/]+/g, "~");
  trimmed = trimmed.replace(/\bfile:\/\/\S+/g, "file://<path>");
  // Drop anything that looks like a JWT or long opaque token.
  trimmed = trimmed.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<redacted>");
  // Cap length so a runaway error string cannot bloat persistent state.
  const max = 500;
  if (trimmed.length > max) {
    return `${trimmed.slice(0, max - 1)}…`;
  }
  return trimmed;
}
