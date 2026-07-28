import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "./schemas";
import { selectLastUserTurnAgentSettings } from "./last-turn-agent-settings";

function message(
  role: TranscriptMessage["role"],
  settings: Partial<
    Pick<TranscriptMessage, "model" | "effort" | "codexFastMode">
  > = {},
): TranscriptMessage {
  return {
    role,
    content: [{ type: "text", text: role }],
    timestamp: null,
    ...settings,
  };
}

describe("selectLastUserTurnAgentSettings", () => {
  it("returns the latest user turn's Codex speed together with model and effort", () => {
    expect(
      selectLastUserTurnAgentSettings([
        message("user", {
          model: "gpt-5.4",
          effort: "medium",
          codexFastMode: false,
        }),
        message("assistant"),
        message("user", {
          model: "gpt-5.6",
          effort: "high",
          codexFastMode: true,
        }),
        message("assistant"),
      ]),
    ).toEqual({
      modelId: "gpt-5.6",
      effort: "high",
      codexFastMode: true,
    });
  });

  it("preserves an explicit Standard selection", () => {
    expect(
      selectLastUserTurnAgentSettings([
        message("user", { codexFastMode: false }),
      ]),
    ).toEqual({ codexFastMode: false });
  });
});
