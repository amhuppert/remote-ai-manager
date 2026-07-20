import type { TranscriptMessage } from "./schemas";

export interface LastUserTurnAgentSettings {
  modelId?: string;
  effort?: string;
}

export function selectLastUserTurnAgentSettings(
  messages: readonly TranscriptMessage[],
): LastUserTurnAgentSettings {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    if (message.model === undefined && message.effort === undefined) continue;
    return {
      ...(message.model !== undefined ? { modelId: message.model } : {}),
      ...(message.effort !== undefined ? { effort: message.effort } : {}),
    };
  }
  return {};
}
