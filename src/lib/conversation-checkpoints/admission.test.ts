import { describe, expect, it } from "vitest";

import { conversationCapabilitiesForBackend } from "@/lib/agent-backends/catalog";

import {
  checkpointHoldsExternalAdmission,
  checkpointHoldsOrdinaryAdmission,
  evaluateCheckpointAdmission,
  type CheckpointAdmissionObservation,
  type CheckpointConversationObservation,
  type CheckpointHostObservation,
} from "./admission";
import type { CheckpointOperation, CheckpointPhase } from "./schemas";

function operation(
  overrides: Partial<CheckpointOperation> = {},
): CheckpointOperation {
  return {
    id: "op-1",
    scope: "session",
    projectPath: "/projects/alpha",
    sessionName: "csm-alpha",
    conversationId: "conv-1",
    ordinal: 1,
    phase: "building",
    lastStablePhase: null,
    sourceBasis: { capturedThroughSeq: 12, sourceHash: "sha256:source" },
    protectedReferences: { priorBackendRef: "prior", acceptedBackendRef: null },
    payloadId: null,
    delivery: null,
    acceptance: null,
    failure: null,
    recoversOperationId: null,
    supersededByOperationId: null,
    generationPassCount: null,
    usage: {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: null,
    },
    requestedAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

const ORDINARY: CheckpointConversationObservation = {
  archived: false,
  role: null,
  owned: false,
  agentBackend: "claude",
  debugActive: false,
  questionPending: false,
  transient: false,
  promptCount: 3,
  transcriptPath: "/transcripts/conv-1.jsonl",
  running: false,
};

const SETTLED_HOST: CheckpointHostObservation = {
  idle: true,
  turnActive: false,
  busy: false,
  trackedWork: false,
};

function observe(
  overrides: Partial<CheckpointAdmissionObservation> = {},
): CheckpointAdmissionObservation {
  return {
    requestId: "req-1",
    recover: null,
    conversation: ORDINARY,
    backendSupportsCheckpoint: true,
    host: SETTLED_HOST,
    reservation: null,
    backgroundActivity: false,
    queueReviewRequired: false,
    continuationLost: null,
    checkpoints: { active: null, latestAccepted: null },
    ...overrides,
  };
}

function codes(observation: CheckpointAdmissionObservation): string[] {
  const verdict = evaluateCheckpointAdmission(observation);
  return verdict.eligible ? [] : verdict.refusals.map((r) => r.code);
}

describe("evaluateCheckpointAdmission — eligibility matrix", () => {
  it("admits an ordinary Codex conversation through the shipped capability", () => {
    expect(
      evaluateCheckpointAdmission(
        observe({
          conversation: { ...ORDINARY, agentBackend: "codex" },
          backendSupportsCheckpoint:
            conversationCapabilitiesForBackend("codex").checkpoint,
        }),
      ),
    ).toEqual({ eligible: true, reuse: null, recovers: null });
  });

  it("admits a settled ordinary hosted conversation on a supported backend", () => {
    expect(evaluateCheckpointAdmission(observe())).toEqual({
      eligible: true,
      reuse: null,
      recovers: null,
    });
  });

  it("admits a dormant host whose durable row is settled", () => {
    expect(evaluateCheckpointAdmission(observe({ host: null })).eligible).toBe(
      true,
    );
  });

  it("refuses a missing conversation with nothing else", () => {
    expect(codes(observe({ conversation: null }))).toEqual([
      "conversation_not_found",
    ]);
  });

  it.each([
    ["transient", { transient: true }, "conversation_transient"],
    ["archived", { archived: true }, "conversation_archived"],
    ["workflow role", { role: "iteration" as const }, "conversation_owned"],
    ["validator role", { role: "validator" as const }, "conversation_owned"],
    ["collaboration owner", { owned: true }, "conversation_owned"],
    ["debug mode", { debugActive: true }, "debug_mode"],
    ["parked question", { questionPending: true }, "question_pending"],
    [
      "no transcript",
      { transcriptPath: null, promptCount: 0 },
      "no_recorded_history",
    ],
  ] satisfies [string, Partial<CheckpointConversationObservation>, string][])(
    "refuses a %s conversation before any provider allocation",
    (_label, overrides, code) => {
      expect(
        codes(observe({ conversation: { ...ORDINARY, ...overrides } })),
      ).toEqual([code]);
    },
  );

  it("refuses an ordinary role that a collaboration still owns", () => {
    expect(
      codes(
        observe({ conversation: { ...ORDINARY, role: null, owned: true } }),
      ),
    ).toEqual(["conversation_owned"]);
  });

  it("refuses a backend whose descriptor has not been certified", () => {
    expect(codes(observe({ backendSupportsCheckpoint: false }))).toEqual([
      "backend_unsupported",
    ]);
  });

  it.each([
    ["admitted turn", { turnActive: true }, "turn_active"],
    ["actor away from idle", { idle: false }, "turn_active"],
    ["tracked runtime work", { trackedWork: true }, "background_work"],
    ["stop or disposal", { busy: true }, "conversation_busy"],
  ] satisfies [string, Partial<CheckpointHostObservation>, string][])(
    "refuses a hosted conversation with %s",
    (_label, overrides, code) => {
      expect(
        codes(observe({ host: { ...SETTLED_HOST, ...overrides } })),
      ).toEqual([code]);
    },
  );

  it("refuses live background activity from the registry", () => {
    expect(codes(observe({ backgroundActivity: true }))).toEqual([
      "background_work",
    ]);
  });

  it("treats a running durable row as an active turn when no host exists", () => {
    expect(
      codes(
        observe({ host: null, conversation: { ...ORDINARY, running: true } }),
      ),
    ).toEqual(["turn_active"]);
  });

  it("lets the hosted actor speak for a stale running row", () => {
    expect(
      codes(observe({ conversation: { ...ORDINARY, running: true } })),
    ).toEqual([]);
  });

  it("reports every failing predicate so a check can list findings", () => {
    expect(
      codes(
        observe({
          conversation: { ...ORDINARY, archived: true, debugActive: true },
          backgroundActivity: true,
        }),
      ),
    ).toEqual(["conversation_archived", "debug_mode", "background_work"]);
  });

  it.each([
    "building",
    "retiring",
    "ready",
    "delivering",
  ] satisfies CheckpointPhase[])(
    "refuses a different request while a %s operation holds the slot",
    (phase) => {
      const active = operation({ phase });
      const verdict = evaluateCheckpointAdmission(
        observe({
          requestId: "req-other",
          checkpoints: { active, latestAccepted: null },
        }),
      );
      expect(verdict).toMatchObject({
        eligible: false,
        refusals: [{ code: "checkpoint_pending", operationId: "op-1", phase }],
      });
    },
  );

  it("returns the existing operation when the same request id repeats", () => {
    const active = operation({ id: "req-1", phase: "ready" });
    expect(
      evaluateCheckpointAdmission(
        observe({
          requestId: "req-1",
          checkpoints: { active, latestAccepted: null },
        }),
      ),
    ).toEqual({ eligible: true, reuse: active, recovers: null });
  });

  it("names the blocked operation when ordinary start meets a reconciliation hold", () => {
    const active = operation({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
    });
    expect(
      evaluateCheckpointAdmission(
        observe({ checkpoints: { active, latestAccepted: null } }),
      ),
    ).toMatchObject({
      eligible: false,
      refusals: [
        {
          code: "recovery_required",
          operationId: "op-1",
          phase: "needs_reconciliation",
        },
      ],
    });
  });

  it("refuses while another maintenance in this process is still reserving", () => {
    expect(codes(observe({ reservation: { operationId: null } }))).toEqual([
      "checkpoint_pending",
    ]);
    expect(
      codes(observe({ reservation: { operationId: "op-reserving" } })),
    ).toEqual(["checkpoint_pending"]);
  });

  it("refuses a reservation on a dormant host with no hosted state at all", () => {
    expect(
      codes(observe({ host: null, reservation: { operationId: null } })),
    ).toEqual(["checkpoint_pending"]);
  });

  it("does not refuse the reserving request its own reservation belongs to", () => {
    const active = operation({ id: "req-1", phase: "building" });
    const verdict = evaluateCheckpointAdmission(
      observe({
        requestId: "req-1",
        reservation: { operationId: "req-1" },
        checkpoints: { active, latestAccepted: null },
      }),
    );
    expect(verdict).toMatchObject({ eligible: true, reuse: { id: "req-1" } });
  });

  it("admits a recovery that addresses the blocked operation", () => {
    const active = operation({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
    });
    expect(
      evaluateCheckpointAdmission(
        observe({
          recover: "op-1",
          checkpoints: { active, latestAccepted: null },
        }),
      ),
    ).toEqual({ eligible: true, reuse: null, recovers: active });
  });

  it.each([
    ["no active operation", null],
    [
      "a different operation",
      operation({ id: "op-2", phase: "needs_reconciliation" }),
    ],
    ["an operation that is not blocked", operation({ phase: "ready" })],
    [
      "an operation already superseded",
      operation({
        phase: "needs_reconciliation",
        supersededByOperationId: "op-3",
      }),
    ],
  ] satisfies [string, CheckpointOperation | null][])(
    "refuses a recovery naming %s",
    (_label, active) => {
      expect(
        codes(
          observe({
            recover: "op-1",
            checkpoints: { active, latestAccepted: null },
          }),
        ),
      ).toEqual(["recovery_target_mismatch"]);
    },
  );

  it("still applies the settled-state predicates to a recovery", () => {
    const active = operation({
      phase: "needs_reconciliation",
      lastStablePhase: "retiring",
    });
    expect(
      codes(
        observe({
          recover: "op-1",
          host: { ...SETTLED_HOST, turnActive: true },
          checkpoints: { active, latestAccepted: null },
        }),
      ),
    ).toEqual(["turn_active"]);
  });
});

describe("checkpointHoldsOrdinaryAdmission", () => {
  it.each([
    "building",
    "retiring",
    "delivering",
    "needs_reconciliation",
  ] satisfies CheckpointPhase[])(
    "holds ordinary admission while the projection is %s",
    (phase) => {
      expect(
        checkpointHoldsOrdinaryAdmission({ operationId: "op-1", phase }),
      ).toBe(true);
    },
  );

  it.each([
    "ready",
    "applied",
    "failed",
    "cancelled",
  ] satisfies CheckpointPhase[])(
    "releases ordinary admission when the projection is %s",
    (phase) => {
      expect(
        checkpointHoldsOrdinaryAdmission({ operationId: "op-1", phase }),
      ).toBe(false);
    },
  );

  it("treats an absent projection as no hold", () => {
    expect(checkpointHoldsOrdinaryAdmission(null)).toBe(false);
    expect(checkpointHoldsOrdinaryAdmission(undefined)).toBe(false);
  });
});

describe("checkpointHoldsExternalAdmission", () => {
  it("lets a provider-initiated turn through while a build is in progress, so the build yields to it", () => {
    expect(
      checkpointHoldsExternalAdmission({
        operationId: "op-1",
        phase: "building",
      }),
    ).toBe(false);
  });

  it.each([
    "retiring",
    "delivering",
    "needs_reconciliation",
  ] satisfies CheckpointPhase[])(
    "refuses external admission while the runtime is retired or replaced (%s)",
    (phase) => {
      expect(
        checkpointHoldsExternalAdmission({ operationId: "op-1", phase }),
      ).toBe(true);
    },
  );

  it("treats an absent or released projection as no hold", () => {
    expect(checkpointHoldsExternalAdmission(null)).toBe(false);
    expect(checkpointHoldsExternalAdmission(undefined)).toBe(false);
    expect(
      checkpointHoldsExternalAdmission({ operationId: "op-1", phase: "ready" }),
    ).toBe(false);
  });
});
