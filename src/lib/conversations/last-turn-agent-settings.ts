import type { TranscriptMessage } from "./schemas";

export interface TurnAgentSettingsCandidate {
  model?: unknown;
  effort?: unknown;
  codexFastMode?: unknown;
}

export interface TurnAgentSettings {
  model: string | undefined;
  effort: string | undefined;
  codexFastMode: boolean | undefined;
}

export interface LastUserTurnAgentSettings {
  modelId?: string;
  effort?: string;
  codexFastMode?: boolean;
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

    const model =
      typeof candidate.model === "string" ? candidate.model : undefined;
    const effort =
      typeof candidate.effort === "string" ? candidate.effort : undefined;
    const codexFastMode =
      typeof candidate.codexFastMode === "boolean"
        ? candidate.codexFastMode
        : undefined;

    if (
      model === undefined &&
      effort === undefined &&
      codexFastMode === undefined
    ) {
      continue;
    }

    selected = { model, effort, codexFastMode };
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

  return {
    ...(selected.model !== undefined ? { modelId: selected.model } : {}),
    ...(selected.effort !== undefined ? { effort: selected.effort } : {}),
    ...(selected.codexFastMode !== undefined
      ? { codexFastMode: selected.codexFastMode }
      : {}),
  };
}
