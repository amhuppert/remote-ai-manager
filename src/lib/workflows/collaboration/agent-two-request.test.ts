import { describe, expect, it } from "vitest";
import { buildAgentTwoStartRequest } from "./agent-two-request";

describe("buildAgentTwoStartRequest", () => {
  it("forwards one complete Codex model selection and a qualified profile", () => {
    expect(
      buildAgentTwoStartRequest({
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "xhigh", fast: "true" },
        },
        profile: "project:reviewer",
      }),
    ).toEqual({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "xhigh", fast: "true" },
      },
      profile: { tier: "project", id: "reviewer" },
    });
  });

  it("omits the Standard Agent profile without changing the selection", () => {
    expect(
      buildAgentTwoStartRequest({
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        profile: "builtin:standard-agent",
      }),
    ).toEqual({
      backend: "claude",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    });
  });

  it("refuses the draft when a supplied model selection is invalid", () => {
    expect(
      buildAgentTwoStartRequest({
        backend: "codex",
        modelSelection: {
          modelId: "",
          parameters: { reasoning: "high", fast: "true" },
        },
      }),
    ).toBeNull();
  });
});
