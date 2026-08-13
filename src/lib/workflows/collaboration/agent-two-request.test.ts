import { describe, expect, it } from "vitest";
import { buildAgentTwoStartRequest } from "./agent-two-request";

describe("buildAgentTwoStartRequest", () => {
  it("maps the Codex draft fields and a qualified profile", () => {
    expect(
      buildAgentTwoStartRequest({
        backend: "codex",
        model: "gpt-5.4",
        effort: "xhigh",
        fastMode: true,
        profile: "project:reviewer",
      }),
    ).toEqual({
      backend: "codex",
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
      fastMode: true,
      profile: { tier: "project", id: "reviewer" },
    });
  });

  it("omits Codex-only speed and the Standard Agent profile for Claude", () => {
    expect(
      buildAgentTwoStartRequest({
        backend: "claude",
        model: "opus",
        effort: "high",
        fastMode: true,
        profile: "builtin:standard-agent",
      }),
    ).toEqual({
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
    });
  });

  it("falls back to backend-only when a stale runtime selection is invalid", () => {
    expect(
      buildAgentTwoStartRequest({
        backend: "codex",
        model: "retired-model",
        effort: "unknown",
        fastMode: true,
      }),
    ).toEqual({ backend: "codex" });
  });
});
