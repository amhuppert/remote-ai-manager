import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { ImplementerLaneWriteEnvelope } from "@/lib/workflow-graph/implementer-lane-write-envelope";
import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import type { TurnExecutionOutcome } from "@/lib/workflows/conversation/turn-result";
import type { ConversationRecordPort } from "./conversation-record";
import { createNativeSeatTurns, type NativeSeatTurnDeps } from "./native-seat-turns";
import type { SeatBindingRecord, SeatTurnRequest } from "./schemas";
import type { TurnRequest } from "./turn-engine";

const binding: SeatBindingRecord = {
  conversationId: "conv-1",
  contextId: "ctx-1",
  assignmentId: "implementer",
  replacement: 0,
  role: "implementer",
  projectPath: "/repo",
  sessionName: "session",
  backend: "claude",
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
};

function request(overrides: Partial<SeatTurnRequest> = {}): SeatTurnRequest {
  return {
    kind: "work",
    workspace: {
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      access: "write",
      scope: { mode: "full" },
    },
    seat: {
      contextId: "ctx-1",
      assignmentId: "implementer",
      role: "implementer",
      assignment: {
        id: "implementer",
        profile: { tier: "builtin", id: "standard-agent" },
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: {} },
      },
      replacement: 0,
      canAsk: true,
    },
    message: "Implement the task",
    timeoutMs: null,
    ...overrides,
  };
}

const reviewRequest = (): SeatTurnRequest =>
  request({
    kind: "review",
    workspace: { ...request().workspace, access: "stable_read" },
    seat: { ...request().seat, assignmentId: "reviewer-a", role: "reviewer", canAsk: false },
    outputSchema: { type: "object" },
    message: "Review the candidate",
  });

function outcomeOf(execution: ReturnType<typeof settledConversationTurn>): TurnExecutionOutcome {
  if (execution.kind !== "settled") throw new Error("fixture");
  return execution.turn.outcome;
}

function harness(answer: (turn: TurnRequest) => Promise<TurnExecutionOutcome>) {
  const turns: TurnRequest[] = [];
  const events: string[] = [];
  const released: string[] = [];
  let backendRef: { backend: "claude"; ref: string } | null = { backend: "claude", ref: "sdk-1" };
  const records: ConversationRecordPort = {
    async read() {
      return { agentBackend: "claude", backendRef, promptCount: 1, transcriptPath: null, queueReviewRequired: false, debugMode: null };
    },
    async beginTurn(identity, source) {
      events.push(`begin:${identity.conversationId}:${source}`);
    },
    async recordInterrupted() {},
    async recordWithdrawn() {},
    async claimTurn() {},
    async endClaim() {},
    hasPendingQuestion: () => false,
    async withdrawQuestion() {
      return false;
    },
    async adoptBackend() {},
    async admitProfile(identity) {
      events.push(`profile:${identity.conversationId}`);
      return { instructionBlock: null, snapshot: null, lockedAt: null };
    },
    async recordContinuity(identity, ref) {
      events.push(`continuity:${identity.conversationId}:${ref.ref}`);
    },
    async settleTurn(identity, settlement, source) {
      events.push(`settle:${identity.conversationId}:${settlement.counted}:${source}`);
      if (settlement.continuity.kind === "set") backendRef = { backend: "claude", ref: settlement.continuity.ref.ref };
      return { debug: null };
    },
  };
  const deps: NativeSeatTurnDeps = {
    engine: {
      async runTurn(turn) {
        turns.push(turn);
        return answer(turn);
      },
    },
    records,
    host: {
      async release(conversationId) {
        released.push(conversationId);
      },
    },
    getProjectDisplayName: () => "repo",
    composeWriteEnvelope: (input): ImplementerLaneWriteEnvelope => ({
      policy: { mode: "allowlist", allowWrite: [`${input.worktreePath}/src/api`], denyWrite: [] },
      worktreeRoot: input.worktreePath,
      contextScratchDir: "/scratch/ctx-1",
      contextTmpDir: "/tmp/ctx-1",
      payloadDir: "/scratch/ctx-1/payload",
      ownedPrefixes: input.ownedPaths,
    }),
    fsWriteRestriction: () => "enforced",
    log: createCapturingLogger(),
  };
  const run = (req: SeatTurnRequest, signal = new AbortController().signal) =>
    createNativeSeatTurns(deps).run({ conversationId: "conv-1", binding, request: req, attemptId: "attempt-1", signal });
  return { deps, run, turns, events, released };
}

describe("native seat turns", () => {
  it("runs a work turn as the seat itself, resuming its continuity, and records the turn on the conversation", async () => {
    const h = harness(async () =>
      outcomeOf(
        settledConversationTurn({
          backendRef: { backend: "claude", ref: "sdk-2" },
          outcome: { kind: "completed", text: "Changed notice.ts" },
        }),
      ),
    );
    const result = await h.run(request());

    expect(result).toEqual({
      status: "succeeded",
      finalText: "Changed notice.ts",
      structuredOutput: null,
      outputIssue: null,
      failure: null,
    });
    const turn = h.turns[0];
    expect(turn?.conversation).toMatchObject({
      conversationId: "conv-1",
      executionClass: "governed-execution",
      persistedRef: { backend: "claude", ref: "sdk-1" },
      callerIdentity: "conv-1",
      target: { scope: "session", projectName: "repo", sessionName: "session", conversationId: "conv-1" },
      worktreePath: "/repo/.worktrees/session",
    });
    expect(turn).toMatchObject({
      promptText: "Implement the task",
      writeCapability: "write_capable",
      autonomous: true,
      waitForBackgroundTasks: true,
      requirements: {
        modelSelection: { modelId: "sonnet", parameters: {} },
        instructionSelection: { autonomous: true, askUserQuestionsEnabled: true },
      },
    });
    expect(turn?.outputFormat).toBeUndefined();
    expect(h.events).toEqual(["begin:conv-1:workflow", "profile:conv-1", "settle:conv-1:true:workflow"]);
    expect(h.released).toEqual(["conv-1"]);
  });

  it("records the seat's continuation the moment the backend announces it", async () => {
    const h = harness(async (turn) => {
      await turn.onBackendInit?.({ backend: "claude", ref: "sdk-early" });
      return outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text: "ok" } }));
    });
    await h.run(request());
    expect(h.events).toEqual([
      "begin:conv-1:workflow",
      "profile:conv-1",
      "continuity:conv-1:sdk-early",
      "settle:conv-1:true:workflow",
    ]);
  });

  it("settles the conversation row even when the turn itself throws", async () => {
    const h = harness(async () => {
      throw new Error("config unreadable");
    });
    const result = await h.run(request());

    expect(result).toMatchObject({ status: "failed", failure: "config unreadable" });
    expect(h.events).toEqual(["begin:conv-1:workflow", "profile:conv-1", "settle:conv-1:false:workflow"]);
    expect(h.released).toEqual(["conv-1"]);
  });

  it("reports a runtime it could not close, so the core keeps what the seat holds", async () => {
    const h = harness(async () => outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text: "ok" } })));
    h.deps.host = {
      async release() {
        throw new Error("child process cleanup could not be verified");
      },
    };
    const result = await h.run(request());
    expect(result.runtimeUncollected).toBe("child process cleanup could not be verified");
  });

  it("asks a review for structured output read-only and releases the reviewer's runtime afterwards", async () => {
    const h = harness(async () =>
      outcomeOf(
        settledConversationTurn({
          outcome: { kind: "completed", text: "", structuredOutput: { verdict: "pass", findings: [], advisories: [] } },
        }),
      ),
    );
    const result = await h.run(reviewRequest());

    expect(result.structuredOutput).toEqual({ verdict: "pass", findings: [], advisories: [] });
    expect(h.turns[0]).toMatchObject({
      outputFormat: { type: "json_schema", schema: { type: "object" } },
      structuredOutputTurns: "work_then_format",
      writeCapability: "read_only",
      waitForBackgroundTasks: false,
      requirements: { instructionSelection: { askUserQuestionsEnabled: false } },
    });
    expect(h.released).toEqual(["conv-1"]);
  });

  it("reports a schema refusal as an output issue, a provider failure as failed and a cancelled turn as cancelled", async () => {
    const refusal = await harness(async () =>
      outcomeOf(
        settledConversationTurn({
          outcome: {
            kind: "failed",
            error: {
              backend: "claude",
              failureKind: "schema_validation",
              message: "structured output failed validation",
              backendDetails: { issues: ["/verdict: invalid"] },
            },
          },
        }),
      ),
    ).run(reviewRequest());
    expect(refusal).toMatchObject({ status: "succeeded", failure: null });
    expect(refusal.outputIssue).toContain("structured output");

    const failure = await harness(async () =>
      outcomeOf(
        settledConversationTurn({
          outcome: { kind: "failed", error: { backend: "claude", failureKind: "backend_error", message: "SDK transport closed" } },
        }),
      ),
    ).run(request());
    expect(failure).toMatchObject({ status: "failed", failure: "SDK transport closed" });

    const cancelled = await harness(async () => ({
      ...outcomeOf(
        settledConversationTurn({
          outcome: { kind: "failed", error: { backend: "claude", failureKind: "aborted", message: "aborted" } },
        }),
      ),
      interruption: { reason: "user" },
    })).run(request());
    expect(cancelled.status).toBe("cancelled");
  });

  it("reports a turn the server stopped before it began as interrupted, not cancelled", async () => {
    const h = harness(async () => ({
      kind: "not_started",
      reason: "cancelled",
      message: "The turn was cancelled before it started",
      interruption: { reason: "shutdown" },
    }));
    expect((await h.run(request())).status).toBe("interrupted");
  });

  it("aborts a turn that outlives its timeout and reports it as failed", async () => {
    const h = harness(
      (turn) =>
        new Promise((resolve) =>
          turn.signal.addEventListener("abort", () =>
            resolve({
              ...outcomeOf(
                settledConversationTurn({
                  outcome: { kind: "failed", error: { backend: "claude", failureKind: "aborted", message: "aborted" } },
                }),
              ),
              interruption: { reason: "user" },
            }),
          ),
        ),
    );
    const result = await h.run(request({ timeoutMs: 5 }));

    expect(result.status).toBe("failed");
    expect(result.failure).toContain("timed out after 5ms");
  });

  it("confines an owned write scope with its write envelope, and refuses one the backend cannot limit", async () => {
    const owned = request({ workspace: { ...request().workspace, scope: { mode: "owned", paths: ["src/api"] } } });
    const h = harness(async () => outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text: "ok" } })));
    await h.run(owned);
    expect(h.turns[0]?.requirements.fsWritePolicy).toEqual({
      mode: "allowlist",
      allowWrite: ["/repo/.worktrees/session/src/api"],
      denyWrite: [],
    });
    expect(h.turns[0]?.promptText).toContain("Writable repository paths");

    const refused = harness(async () => outcomeOf(settledConversationTurn()));
    refused.deps.fsWriteRestriction = () => "unsupported";
    const result = await createNativeSeatTurns(refused.deps).run({
      conversationId: "conv-1",
      binding,
      request: owned,
      attemptId: "attempt-1",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(result.failure).toContain("cannot limit");
    expect(refused.turns).toEqual([]);
    expect(refused.events).toEqual([]);
  });
});
