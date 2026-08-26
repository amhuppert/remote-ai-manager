import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "./schemas";
import { selectLastUserTurnAgentSettings } from "./last-turn-agent-settings";

function message(
  role: TranscriptMessage["role"],
  settings: Pick<TranscriptMessage, "modelSelection"> = {},
): TranscriptMessage {
  return {
    role,
    content: [{ type: "text", text: role }],
    timestamp: null,
    ...settings,
  };
}

describe("selectLastUserTurnAgentSettings", () => {
  it("returns the latest complete model selection without reconstructing fields", () => {
    const messages = [
      {
        ...message("user"),
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "false", reasoning: "high" },
        },
      },
      message("assistant"),
      {
        ...message("user"),
        modelSelection: {
          modelId: "gpt-5.6-sol",
          parameters: { fast: "true", reasoning: "ultra" },
        },
      },
    ] as unknown as TranscriptMessage[];

    expect(selectLastUserTurnAgentSettings(messages)).toEqual({
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { fast: "true", reasoning: "ultra" },
      },
    });
  });

  it("ignores assistant selections when finding the latest user selection", () => {
    expect(
      selectLastUserTurnAgentSettings([
        message("user", {
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "false", reasoning: "medium" },
          },
        }),
        message("assistant", {
          modelSelection: {
            modelId: "gpt-5.5",
            parameters: { fast: "false", reasoning: "low" },
          },
        }),
        message("user", {
          modelSelection: {
            modelId: "gpt-5.6-sol",
            parameters: { fast: "true", reasoning: "high" },
          },
        }),
        message("assistant"),
      ]),
    ).toEqual({
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { fast: "true", reasoning: "high" },
      },
    });
  });

  it("returns no partial settings for a user turn without a selection", () => {
    expect(selectLastUserTurnAgentSettings([message("user")])).toEqual({});
  });
});
