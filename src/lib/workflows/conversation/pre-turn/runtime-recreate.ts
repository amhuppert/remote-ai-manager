/**
 * Pre-turn step: whether the next turn reuses the registered backend runtime
 * or builds a new one.
 *
 * Owned here rather than inside the turn because two callers ask it and they
 * must not disagree: the turn itself, which closes the runtime it is about to
 * replace, and the memory index preview, which claims to render the block that
 * turn will inject — and a runtime rebuilt without a resume handle is one of
 * the enumerated context-loss events that make that block a full one.
 */

import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { modelSelectionKey } from "@/lib/agent-backends/model-selection";

/**
 * The configuration a live runtime baked in when it started. Structural rather
 * than the full `ConversationBackendRuntime` so a caller holding only a
 * registry snapshot — the preview does — can ask the same question.
 */
export interface RecreateRuntimeSnapshot {
  status: string;
  modelSelection: BackendModelSelection;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  alignmentVersion?: number | null;
  fsWritePolicy?: FsWritePolicy;
}

/**
 * Determine whether an existing backend runtime should be closed and recreated
 * because the model selection, outputFormat, or baked-in alignment charter
 * version changed. An alignment-version mismatch is the seam that guarantees a
 * charter change propagates to an already-running runtime (R7.3): the new
 * version is baked into the rebuilt session instructions on recreation.
 */
export function shouldRecreateRuntime(
  runtime: RecreateRuntimeSnapshot | undefined,
  effectiveModelSelection: BackendModelSelection,
  desiredOutputFormat?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  },
  desiredAlignmentVersion: number | null = null,
  desiredFsWritePolicy?: FsWritePolicy,
): boolean {
  if (!runtime || runtime.status !== "alive") return false;
  const modelSelectionChanged =
    modelSelectionKey(runtime.modelSelection) !==
    modelSelectionKey(effectiveModelSelection);
  const outputFormatChanged = runtime.outputFormat !== desiredOutputFormat;
  const alignmentChanged =
    (runtime.alignmentVersion ?? null) !== desiredAlignmentVersion;
  return (
    modelSelectionChanged ||
    outputFormatChanged ||
    alignmentChanged ||
    fsWritePolicyChanged(runtime.fsWritePolicy, desiredFsWritePolicy)
  );
}

/**
 * Whether a live runtime's baked-in write envelope differs from the one this
 * turn must run under. Compared by VALUE because the composer builds a fresh
 * policy object per turn, and by content because an ownership change (live edit,
 * plan repair) has to reach an already-running lane: the envelope is established
 * when the backend session starts, so a changed policy needs a new session, and
 * the direction that matters most is a policy appearing where there was none —
 * reusing the unrestricted runtime would run the turn outside its envelope.
 */
export function fsWritePolicyChanged(
  current: FsWritePolicy | undefined,
  desired: FsWritePolicy | undefined,
): boolean {
  if (current === undefined || desired === undefined) {
    return current !== desired;
  }
  return JSON.stringify(current) !== JSON.stringify(desired);
}

/** The configuration the next turn would run under. */
export interface DesiredRuntimeConfiguration {
  modelSelection: BackendModelSelection;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  alignmentVersion: number | null;
  fsWritePolicy?: FsWritePolicy;
}

/**
 * Whether the next turn ends up on a NEW runtime — the composite the turn
 * performs in two steps (close a drifted runtime, then treat a missing or dead
 * one as new). Expressed through {@link shouldRecreateRuntime} rather than
 * beside it so a dimension added to the recreate rule is answered here too,
 * instead of being silently ignored by the caller that only predicts.
 */
export function willNextTurnCreateRuntime(input: {
  runtime: RecreateRuntimeSnapshot | undefined;
  desired: DesiredRuntimeConfiguration;
}): boolean {
  const { runtime, desired } = input;
  if (!runtime || runtime.status === "dead") return true;
  return shouldRecreateRuntime(
    runtime,
    desired.modelSelection,
    desired.outputFormat,
    desired.alignmentVersion,
    desired.fsWritePolicy,
  );
}
