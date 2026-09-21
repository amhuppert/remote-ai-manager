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
import type { AgentBackendId } from "@/lib/shared/schemas";
import { stableStringify } from "@/lib/state-store/serialization";

/** Configuration selected by CC and baked into a hosted backend session. */
export interface DesiredRuntimeConfiguration {
  backend: AgentBackendId;
  modelSelection: BackendModelSelection;
  alignmentVersion: number | null;
  /** The write envelope is established at session start; even newly adding confinement requires recreation. */
  fsWritePolicy?: FsWritePolicy;
  repeatableInstructions: readonly string[];
  /** Known dispatch policy used by the read-only at-rest instruction projection. */
  instructionSelection: {
    askUserQuestionsEnabled?: boolean;
    autonomous: boolean;
  };
}

export interface RecreateRuntimeSnapshot extends DesiredRuntimeConfiguration {
  status: string;
}

export function runtimeConfigurationChanges(input: {
  current: RecreateRuntimeSnapshot | undefined;
  desired: DesiredRuntimeConfiguration;
}): string[] {
  const { current, desired } = input;
  if (!current || current.status !== "alive") return [];
  const dimensions = [
    "backend",
    "modelSelection",
    "alignmentVersion",
    "fsWritePolicy",
    "repeatableInstructions",
  ] as const;
  return dimensions.filter(
    (key) => stableStringify(current[key]) !== stableStringify(desired[key]),
  );
}

/** Changed creation requirements must be applied before dispatch. */
export function shouldRecreateRuntime(input: {
  current: RecreateRuntimeSnapshot | undefined;
  desired: DesiredRuntimeConfiguration;
}): boolean {
  return runtimeConfigurationChanges(input).length > 0;
}

/** Missing/dead handles also require creation, without a live handle to close. */
export function willNextTurnCreateRuntime(input: {
  runtime: RecreateRuntimeSnapshot | undefined;
  desired: DesiredRuntimeConfiguration;
}): boolean {
  if (!input.runtime || input.runtime.status === "dead") return true;
  return shouldRecreateRuntime({
    current: input.runtime,
    desired: input.desired,
  });
}
