import {
  backendModelSelectionSchema,
  type BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import type { TranscriptMessage } from "./schemas";

export interface TurnAgentSettingsCandidate {
  modelSelection?: unknown;
}

export interface TurnAgentSettings {
  modelSelection: BackendModelSelection;
}

export interface LastUserTurnAgentSettings {
  modelSelection?: BackendModelSelection;
}

/**
 * Select the latest candidate containing agent settings as one atomic bundle.
 * Missing fields clear earlier values, while metadata-free transcript fragments
 * keep the latest explicit bundle for their logical turn.
 */
export function selectLatestExplicitTurnAgentSettings(
  candidates: Iterable<TurnAgentSettingsCandidate | null | undefined>,
): TurnAgentSettings | undefined {
  let selected: TurnAgentSettings | undefined;

  for (const candidate of candidates) {
    if (!candidate) continue;

    const parsed = backendModelSelectionSchema.safeParse(
      candidate.modelSelection,
    );
    if (!parsed.success) continue;
    selected = { modelSelection: parsed.data };
  }

  return selected;
}

export function selectLastUserTurnAgentSettings(
  messages: readonly TranscriptMessage[],
): LastUserTurnAgentSettings {
  const selected = selectLatestExplicitTurnAgentSettings(
    messages.filter((message) => message.role === "user"),
  );
  if (!selected) return {};
  return { modelSelection: selected.modelSelection };
}
