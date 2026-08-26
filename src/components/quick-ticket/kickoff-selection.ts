import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/catalog";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { QuickTicketDraft } from "@/stores/quick-ticket.store";

export type KickoffDraftSelection = Pick<
  QuickTicketDraft,
  "kickoffBackend" | "kickoffModelSelection"
>;

export interface ResolvedKickoffSelection {
  backend: AgentBackendId;
  modelSelection: BackendModelSelection;
}

function cloneSelection(
  selection: BackendModelSelection,
): BackendModelSelection {
  return {
    modelId: selection.modelId,
    parameters: { ...selection.parameters },
  };
}

/** Resolve the quick-ticket draft as one complete, indivisible selection. */
export function resolveKickoffSelection(input: {
  draft: KickoffDraftSelection;
  defaultBackend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
}): ResolvedKickoffSelection {
  const backend = input.draft.kickoffBackend ?? input.defaultBackend;
  const modelSelection =
    input.draft.kickoffModelSelection ?? input.backendDefaults[backend];

  return { backend, modelSelection: cloneSelection(modelSelection) };
}
