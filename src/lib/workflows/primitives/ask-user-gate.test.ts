import { describe, expect, it } from "vitest";
import type { AgentCallResult } from "./agent-call-vocabulary";
import { askUserGateFromPause, pauseForAskUser } from "./ask-user-gate";
import { gateResultSchema } from "./gate-vocabulary";

const askUserAgentResult: AgentCallResult = {
  backend: "claude",
  backendRef: null,
  capabilities: {
    backend: "claude",
    continuationStrength: "precise_session",
    structuredOutputEnforcement: "post_validation",
    mcpApplicationBoundary: "between_turns",
    contextMetricsAvailable: true,
    nativeMidTurnAskUser: true,
  },
  usage: {},
  artifacts: [],
  outcome: {
    kind: "paused",
    pauseKind: "mid_turn",
    resumeToken: "rt-mid-1",
    details: {
      questions: [
        {
          question: "Which environment?",
          options: [{ label: "prod" }, { label: "stg" }],
          multiSelect: false,
        },
      ],
    },
  },
};

describe("pauseForAskUser", () => {
  it("returns a mid-turn pause gate with the supplied resume token", () => {
    const gate = pauseForAskUser({
      resumeToken: "rt-ask-9",
      questions: [
        {
          question: "Continue?",
          options: [{ label: "Yes" }],
          multiSelect: false,
        },
      ],
    });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("pause");
    if (gate.status === "pause") {
      expect(gate.kind).toBe("ask_user");
      expect(gate.pauseKind).toBe("mid_turn");
      expect(gate.resumeToken).toBe("rt-ask-9");
      expect(gate.details).toMatchObject({
        questions: [{ question: "Continue?" }],
      });
    }
  });

  it("rejects an empty resume token", () => {
    expect(() =>
      pauseForAskUser({
        resumeToken: "",
        questions: [],
      }),
    ).toThrow();
  });
});

describe("askUserGateFromPause", () => {
  it("converts a mid-turn AgentCall paused outcome into an ask_user gate", () => {
    const gate = askUserGateFromPause(askUserAgentResult);
    expect(gate).not.toBeNull();
    if (!gate) return;
    expect(gate.kind).toBe("ask_user");
    expect(gate.pauseKind).toBe("mid_turn");
    expect(gate.resumeToken).toBe("rt-mid-1");
    expect(gate.details).toMatchObject({
      questions:
        askUserAgentResult.outcome.kind === "paused"
          ? askUserAgentResult.outcome.details?.["questions"]
          : undefined,
    });
  });

  it("returns null for a completed AgentCall result", () => {
    const completed: AgentCallResult = {
      ...askUserAgentResult,
      outcome: { kind: "completed", text: "done" },
    };
    expect(askUserGateFromPause(completed)).toBeNull();
  });

  it("returns null for a failed AgentCall result", () => {
    const failed: AgentCallResult = {
      ...askUserAgentResult,
      outcome: {
        kind: "failed",
        error: {
          failureKind: "backend_error",
          backend: "claude",
          message: "oops",
        },
      },
    };
    expect(askUserGateFromPause(failed)).toBeNull();
  });

  it("returns null for a post-turn AgentCall paused outcome", () => {
    const postTurn: AgentCallResult = {
      ...askUserAgentResult,
      outcome: {
        kind: "paused",
        pauseKind: "post_turn",
        resumeToken: "rt-post-1",
      },
    };
    expect(askUserGateFromPause(postTurn)).toBeNull();
  });
});
