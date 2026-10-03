import { describe, expect, it } from "vitest";
import type { ConversationTurnExecution } from "@/lib/workflows/conversation/manager";
import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import type { ConversationTurnSubmission } from "@/lib/workflows/conversation/turn-spec";
import type { ImplementerLaneWriteEnvelope } from "@/lib/workflow-graph/implementer-lane-write-envelope";
import {
  createActorSeatTurns,
  type ActorSeatTurnDeps,
} from "./actor-seat-turns";
import type { SeatBindingRecord, SeatTurnRequest } from "./schemas";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const binding: SeatBindingRecord = {
  conversationId: "conv-1",
  contextId: "ctx-1",
  assignmentId: "implementer",
  replacement: 0,
  role: "implementer",
  projectPath: "/repo",
  sessionName: "session",
  backend: "claude",
  backendRef: null,
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
        modelSelection: { modelId: "sonnet", parameters: { effort: "high" } },
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
    seat: {
      ...request().seat,
      assignmentId: "reviewer-a",
      role: "reviewer",
      canAsk: false,
    },
    outputSchema: { type: "object" },
    message: "Review the candidate",
  });

function harness(
  answer: (
    input: ConversationTurnSubmission,
  ) => Promise<ConversationTurnExecution>,
) {
  const submissions: ConversationTurnSubmission[] = [];
  const stopped: string[] = [];
  const deps: ActorSeatTurnDeps = {
    async executeConversationTurn(input) {
      submissions.push(input);
      return answer(input);
    },
    async stopConversationActor(_projectPath, _sessionName, conversationId) {
      stopped.push(conversationId);
    },
    getProjectDisplayName: () => "repo",
    composeWriteEnvelope: (input): ImplementerLaneWriteEnvelope => ({
      policy: {
        mode: "allowlist",
        allowWrite: [`${input.worktreePath}/src/api`],
        denyWrite: [],
      },
      worktreeRoot: input.worktreePath,
      contextScratchDir: "/scratch/ctx-1",
      contextTmpDir: "/tmp/ctx-1",
      payloadDir: "/scratch/ctx-1/payload",
      ownedPrefixes: input.ownedPaths,
    }),
    fsWriteRestriction: () => "enforced",
    log: silent,
  };
  return { turns: createActorSeatTurns(deps), deps, submissions, stopped };
}

const run = (
  h: ReturnType<typeof harness>,
  req: SeatTurnRequest,
  signal: AbortSignal = new AbortController().signal,
) =>
  h.turns.run({
    conversationId: "conv-1",
    binding,
    request: req,
    attemptId: "attempt-1",
    signal,
  });

describe("actor seat turns", () => {
  it("dispatches a work turn on the seat's own conversation and reports its text", async () => {
    const h = harness(async () =>
      settledConversationTurn({
        backendRef: { backend: "claude", ref: "sdk-session-1" },
        outcome: { kind: "completed", text: "Changed notice.ts" },
      }),
    );
    const result = await run(h, request());

    expect(result).toEqual({
      status: "succeeded",
      finalText: "Changed notice.ts",
      structuredOutput: null,
      outputIssue: null,
      failure: null,
      backendRef: "sdk-session-1",
    });
    const submission = h.submissions[0];
    expect(submission?.binding).toEqual({
      kind: "durable",
      address: {
        projectPath: "/repo",
        target: {
          scope: "session",
          projectName: "repo",
          sessionName: "session",
          conversationId: "conv-1",
        },
      },
      worktreePath: "/repo/.worktrees/session",
    });
    expect(submission?.turn).toMatchObject({
      kind: "conversation_turn",
      promptText: "Implement the task",
      backend: "claude",
      modelSelection: { modelId: "sonnet", parameters: { effort: "high" } },
      autonomous: true,
      waitForBackgroundTasks: true,
      askUserQuestionsEnabled: true,
    });
    expect(submission?.turn).not.toHaveProperty("outputFormat");
    expect(h.stopped).toEqual([]);
  });

  it("asks a review for structured output and releases the reviewer's runtime afterwards", async () => {
    const h = harness(async () =>
      settledConversationTurn({
        outcome: {
          kind: "completed",
          text: "",
          structuredOutput: { verdict: "pass", findings: [], advisories: [] },
        },
      }),
    );
    const result = await run(h, reviewRequest());

    expect(result.status).toBe("succeeded");
    expect(result.structuredOutput).toEqual({
      verdict: "pass",
      findings: [],
      advisories: [],
    });
    expect(h.submissions[0]?.turn).toMatchObject({
      outputFormat: { type: "json_schema", schema: { type: "object" } },
      structuredOutputTurns: "work_then_format",
      askUserQuestionsEnabled: false,
    });
    expect(h.submissions[0]?.turn).not.toHaveProperty("waitForBackgroundTasks");
    expect(h.stopped).toEqual(["conv-1"]);
  });

  it("reports a schema refusal as an output issue on a settled turn, not a failure", async () => {
    const h = harness(async () =>
      settledConversationTurn({
        outcome: {
          kind: "failed",
          error: {
            backend: "claude",
            failureKind: "schema_validation",
            message: "structured output failed validation",
            backendDetails: {
              issues: ["/verdict: must be equal to one of the allowed values"],
            },
          },
          contentBlocks: [{ type: "text", text: '{"verdict":"maybe"}' }],
        },
      }),
    );
    const result = await run(h, reviewRequest());

    expect(result).toMatchObject({
      status: "succeeded",
      structuredOutput: null,
      failure: null,
    });
    expect(result.outputIssue).toContain("structured output");
  });

  it("reports a backend failure, an aborted turn and a refused admission truthfully", async () => {
    const failed = await run(
      harness(async () =>
        settledConversationTurn({
          outcome: {
            kind: "failed",
            error: {
              backend: "claude",
              failureKind: "backend_error",
              message: "SDK transport closed",
            },
          },
        }),
      ),
      request(),
    );
    expect(failed).toMatchObject({
      status: "failed",
      failure: "SDK transport closed",
    });

    const aborted = await run(
      harness(async () =>
        settledConversationTurn({
          outcome: {
            kind: "failed",
            error: {
              backend: "claude",
              failureKind: "aborted",
              message: "aborted",
            },
          },
        }),
      ),
      request(),
    );
    expect(aborted.status).toBe("cancelled");

    const refused = await run(
      harness(async () => ({
        kind: "refused",
        code: "not_found",
        message: "Conversation conv-1 not found",
      })),
      request(),
    );
    expect(refused).toMatchObject({
      status: "failed",
      failure: "Conversation conv-1 not found",
    });
  });

  it("aborts a turn that outlives its timeout and reports it as failed", async () => {
    const h = harness(
      (input) =>
        new Promise((resolve) => {
          input.signal?.addEventListener("abort", () =>
            resolve(
              settledConversationTurn({
                outcome: {
                  kind: "failed",
                  error: {
                    backend: "claude",
                    failureKind: "aborted",
                    message: "aborted",
                  },
                },
              }),
            ),
          );
        }),
    );
    const result = await run(h, request({ timeoutMs: 5 }));

    expect(result.status).toBe("failed");
    expect(result.failure).toContain("timed out after 5ms");
  });

  it("reports a timeout that fires before the turn starts as a timed-out failure", async () => {
    const h = harness(
      (input) =>
        new Promise((resolve) => {
          input.signal?.addEventListener("abort", () =>
            resolve({
              kind: "refused",
              code: "cancelled",
              message: "cancelled while waiting for the conversation",
            }),
          );
        }),
    );
    const result = await run(h, request({ timeoutMs: 5 }));

    expect(result.status).toBe("failed");
    expect(result.failure).toContain("timed out after 5ms");
  });

  it("confines an owned write scope with its write envelope", async () => {
    const h = harness(async () =>
      settledConversationTurn({ outcome: { kind: "completed", text: "ok" } }),
    );
    await run(
      h,
      request({
        workspace: {
          ...request().workspace,
          scope: { mode: "owned", paths: ["src/api"] },
        },
      }),
    );

    const turn = h.submissions[0]?.turn;
    expect(turn).toMatchObject({
      fsWritePolicy: {
        mode: "allowlist",
        allowWrite: ["/repo/.worktrees/session/src/api"],
        denyWrite: [],
      },
    });
    expect(turn?.promptText).toContain("Writable repository paths");
    expect(turn?.promptText).toContain("Implement the task");
  });

  it("refuses an owned write scope on a backend that cannot limit writes, without dispatching", async () => {
    const h = harness(async () => settledConversationTurn());
    h.deps.fsWriteRestriction = () => "unsupported";
    const turns = createActorSeatTurns(h.deps);
    const result = await turns.run({
      conversationId: "conv-1",
      binding,
      request: request({
        workspace: {
          ...request().workspace,
          scope: { mode: "owned", paths: ["src/api"] },
        },
      }),
      attemptId: "attempt-1",
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("failed");
    expect(result.failure).toContain("cannot limit");
    expect(h.submissions).toEqual([]);
  });
});
