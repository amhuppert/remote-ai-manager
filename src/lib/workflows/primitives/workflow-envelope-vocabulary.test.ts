import { describe, expect, it } from "vitest";
import {
  WORKFLOW_ENVELOPE_STATUSES,
  workflowEnvelopePauseSchema,
  workflowEnvelopeSchema,
  workflowEnvelopeStatusSchema,
  type WorkflowEnvelope,
  type WorkflowEnvelopePause,
} from "./workflow-envelope-vocabulary";

const T0 = "2026-04-28T10:00:00.000Z";
const T1 = "2026-04-28T10:05:00.000Z";

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-1",
    workflowType: "collaboration",
    status: "running",
    phase: "initial-proposals",
    createdAt: T0,
    updatedAt: T0,
    featureSnapshot: { round: 0 },
    ...overrides,
  };
}

describe("workflowEnvelopeStatusSchema", () => {
  it("admits the four lifecycle statuses", () => {
    for (const status of WORKFLOW_ENVELOPE_STATUSES) {
      expect(workflowEnvelopeStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects status values outside the lifecycle vocabulary", () => {
    expect(workflowEnvelopeStatusSchema.safeParse("idle").success).toBe(false);
    expect(workflowEnvelopeStatusSchema.safeParse("error").success).toBe(false);
  });
});

describe("workflowEnvelopeSchema", () => {
  it("round-trips a minimal running envelope", () => {
    const parsed = workflowEnvelopeSchema.parse(buildEnvelope());
    expect(parsed.workflowId).toBe("wf-1");
    expect(parsed.workflowType).toBe("collaboration");
    expect(parsed.status).toBe("running");
    expect(parsed.phase).toBe("initial-proposals");
    expect(parsed.createdAt).toBe(T0);
    expect(parsed.updatedAt).toBe(T0);
    expect(parsed.featureSnapshot).toEqual({ round: 0 });
  });

  it("preserves a feature-owned snapshot opaquely", () => {
    const parsed = workflowEnvelopeSchema.parse(
      buildEnvelope({
        featureSnapshot: {
          arbitrary: { nested: ["value", { x: 1 }] },
          opaqueArray: [1, 2, 3],
        },
      }),
    );
    expect(parsed.featureSnapshot).toEqual({
      arbitrary: { nested: ["value", { x: 1 }] },
      opaqueArray: [1, 2, 3],
    });
  });

  it("preserves the parent workflow id when supplied", () => {
    const parsed = workflowEnvelopeSchema.parse(
      buildEnvelope({ parentWorkflowId: "parent-wf" }),
    );
    expect(parsed.parentWorkflowId).toBe("parent-wf");
  });

  it("captures a completedAt timestamp on completed envelopes", () => {
    const parsed = workflowEnvelopeSchema.parse(
      buildEnvelope({
        status: "completed",
        updatedAt: T1,
        completedAt: T1,
      }),
    );
    expect(parsed.status).toBe("completed");
    expect(parsed.completedAt).toBe(T1);
  });

  it("captures a failure summary on failed envelopes", () => {
    const parsed = workflowEnvelopeSchema.parse(
      buildEnvelope({
        status: "failed",
        updatedAt: T1,
        completedAt: T1,
        errorSummary: "Codex backend unavailable after 3 retries",
      }),
    );
    expect(parsed.status).toBe("failed");
    expect(parsed.errorSummary).toBe(
      "Codex backend unavailable after 3 retries",
    );
  });

  it("rejects empty workflow identifiers", () => {
    expect(
      workflowEnvelopeSchema.safeParse(buildEnvelope({ workflowId: "" }))
        .success,
    ).toBe(false);
  });

  it("rejects empty workflow types", () => {
    expect(
      workflowEnvelopeSchema.safeParse(buildEnvelope({ workflowType: "" }))
        .success,
    ).toBe(false);
  });

  it("rejects empty phase identifiers", () => {
    expect(
      workflowEnvelopeSchema.safeParse(buildEnvelope({ phase: "" })).success,
    ).toBe(false);
  });

  it("rejects empty parent workflow ids when the field is supplied", () => {
    expect(
      workflowEnvelopeSchema.safeParse(buildEnvelope({ parentWorkflowId: "" }))
        .success,
    ).toBe(false);
  });

  it("rejects envelopes that omit the featureSnapshot field entirely (snapshot is required, use null when no snapshot yet)", () => {
    const envelopeWithoutSnapshot: Record<string, unknown> = {
      workflowId: "wf-1",
      workflowType: "collaboration",
      status: "running",
      phase: "initial-proposals",
      createdAt: T0,
      updatedAt: T0,
    };
    const result = workflowEnvelopeSchema.safeParse(envelopeWithoutSnapshot);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "featureSnapshot"),
      ).toBe(true);
    }
  });

  it("permits an explicitly null featureSnapshot (no snapshot yet)", () => {
    const parsed = workflowEnvelopeSchema.parse({
      workflowId: "wf-1",
      workflowType: "collaboration",
      status: "running",
      phase: "initial-proposals",
      createdAt: T0,
      updatedAt: T0,
      featureSnapshot: null,
    });
    expect(parsed.featureSnapshot).toBeNull();
  });

  it("rejects an own-property featureSnapshot value of undefined (JSON.stringify would drop it, breaking restart-safety)", () => {
    const envelopeWithUndefinedSnapshot: Record<string, unknown> = {
      workflowId: "wf-1",
      workflowType: "collaboration",
      status: "running",
      phase: "initial-proposals",
      createdAt: T0,
      updatedAt: T0,
      featureSnapshot: undefined,
    };
    const result = workflowEnvelopeSchema.safeParse(
      envelopeWithUndefinedSnapshot,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "featureSnapshot"),
      ).toBe(true);
    }
  });
});

describe("workflowEnvelopePauseSchema", () => {
  it("preserves a mid-turn ask-user pause through round-trip", () => {
    const parsed = workflowEnvelopePauseSchema.parse({
      pauseKind: "mid_turn",
      gateKind: "ask_user",
      resumeToken: "resume-tok-1",
      reason: "Codex needs clarification on lane intent",
    });
    expect(parsed.pauseKind).toBe("mid_turn");
    expect(parsed.gateKind).toBe("ask_user");
    expect(parsed.resumeToken).toBe("resume-tok-1");
  });

  it("preserves a post-turn human-approval pause through round-trip", () => {
    const parsed = workflowEnvelopePauseSchema.parse({
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "approval-tok-2",
    });
    expect(parsed.pauseKind).toBe("post_turn");
    expect(parsed.gateKind).toBe("human_approval");
  });

  it("rejects ask_user gate paired with a post-turn pause kind", () => {
    expect(
      workflowEnvelopePauseSchema.safeParse({
        pauseKind: "post_turn",
        gateKind: "ask_user",
        resumeToken: "tok",
      }).success,
    ).toBe(false);
  });

  it("rejects human_approval gate paired with a mid-turn pause kind", () => {
    expect(
      workflowEnvelopePauseSchema.safeParse({
        pauseKind: "mid_turn",
        gateKind: "human_approval",
        resumeToken: "tok",
      }).success,
    ).toBe(false);
  });

  it("rejects empty resumeTokens", () => {
    expect(
      workflowEnvelopePauseSchema.safeParse({
        pauseKind: "mid_turn",
        gateKind: "ask_user",
        resumeToken: "",
      }).success,
    ).toBe(false);
  });

  it("permits a freeform reason and structured details payload", () => {
    const parsed = workflowEnvelopePauseSchema.parse({
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "tok",
      reason: "Awaiting Alex sign-off on merged design",
      details: { questionId: "q-1", askedAt: T1 },
    });
    expect(parsed.details).toEqual({ questionId: "q-1", askedAt: T1 });
  });
});

describe("workflowEnvelopeSchema — pause projection", () => {
  function pauseFor(
    overrides: Partial<WorkflowEnvelopePause> = {},
  ): WorkflowEnvelopePause {
    return {
      pauseKind: "mid_turn",
      gateKind: "ask_user",
      resumeToken: "resume-1",
      ...overrides,
    };
  }

  it("permits a paused envelope carrying the shared pause projection", () => {
    const parsed = workflowEnvelopeSchema.parse({
      workflowId: "wf-1",
      workflowType: "collaboration",
      status: "paused",
      phase: "round-2",
      createdAt: T0,
      updatedAt: T1,
      featureSnapshot: { round: 2 },
      pause: pauseFor(),
    });
    expect(parsed.status).toBe("paused");
    expect(parsed.pause?.pauseKind).toBe("mid_turn");
    expect(parsed.pause?.resumeToken).toBe("resume-1");
  });

  it("requires the pause field to be set when status is paused", () => {
    expect(
      workflowEnvelopeSchema.safeParse({
        workflowId: "wf-1",
        workflowType: "collaboration",
        status: "paused",
        phase: "round-2",
        createdAt: T0,
        updatedAt: T1,
        featureSnapshot: {},
      }).success,
    ).toBe(false);
  });

  it("forbids the pause field when status is running so projections cannot drift", () => {
    expect(
      workflowEnvelopeSchema.safeParse({
        workflowId: "wf-1",
        workflowType: "collaboration",
        status: "running",
        phase: "active",
        createdAt: T0,
        updatedAt: T1,
        featureSnapshot: {},
        pause: pauseFor(),
      }).success,
    ).toBe(false);
  });

  it("forbids the pause field when status is completed", () => {
    expect(
      workflowEnvelopeSchema.safeParse({
        workflowId: "wf-1",
        workflowType: "collaboration",
        status: "completed",
        phase: "done",
        createdAt: T0,
        updatedAt: T1,
        completedAt: T1,
        featureSnapshot: {},
        pause: pauseFor(),
      }).success,
    ).toBe(false);
  });

  it("requires errorSummary when status is failed (shared failure summary for restart inspection)", () => {
    expect(
      workflowEnvelopeSchema.safeParse({
        workflowId: "wf-1",
        workflowType: "collaboration",
        status: "failed",
        phase: "boom",
        createdAt: T0,
        updatedAt: T1,
        completedAt: T1,
        featureSnapshot: {},
      }).success,
    ).toBe(false);
  });
});
