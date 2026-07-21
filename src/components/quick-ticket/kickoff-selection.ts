import {
  getEffortLevelsForBackend,
  getModelsForBackend,
  isSelectableModelForBackend,
  type BackendSelectionDefaultsById,
} from "@/lib/agent-backends/catalog";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { QuickTicketDraft } from "@/stores/quick-ticket.store";

export type KickoffDraftSelection = Pick<
  QuickTicketDraft,
  "kickoffBackend" | "kickoffModel" | "kickoffReasoningEffort"
>;

export interface ResolvedKickoffSelection {
  backend: AgentBackendId;
  model: string;
  /** Undefined when the resolved model exposes no reasoning-effort input. */
  reasoningEffort: EffortLevel | undefined;
  /** Levels the resolved backend+model accept, for the effort selector. */
  effortLevels: EffortLevel[];
}

/**
 * Resolve the quick-ticket auto-start selection into a triple that is always
 * valid to send: the model belongs to the resolved backend and the effort to
 * the resolved model. Null draft fields follow the configured defaults, so a
 * stashed draft self-heals when it no longer fits the current configuration.
 */
export function resolveKickoffSelection(input: {
  draft: KickoffDraftSelection;
  defaultBackend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
}): ResolvedKickoffSelection {
  const backend = input.draft.kickoffBackend ?? input.defaultBackend;
  const defaults = input.backendDefaults[backend];

  const preferredModel = input.draft.kickoffModel ?? defaults.modelId;
  const model = isSelectableModelForBackend(backend, preferredModel)
    ? preferredModel
    : isSelectableModelForBackend(backend, defaults.modelId)
      ? defaults.modelId
      : getModelsForBackend(backend)[0]!.id;

  const effortLevels = getEffortLevelsForBackend(backend, model);
  const preferredEffort = input.draft.kickoffReasoningEffort ?? defaults.effort;
  const reasoningEffort =
    effortLevels.length === 0
      ? undefined
      : effortLevels.includes(preferredEffort)
        ? preferredEffort
        : effortLevels.includes("high")
          ? "high"
          : effortLevels.at(-1);

  return { backend, model, reasoningEffort, effortLevels };
}
