// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import {
  askQuestionItemSchema,
  type AskQuestionItem,
} from "@/lib/conversations/schemas";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import {
  deriveUserInputStandings,
  useUserInputGate,
  type UserInputStanding,
} from "@/hooks/use-user-input-gate";

const PARKED_CONTEXT_ID = "context-implement";
const ASKING_CONVERSATION_ID = "conv-asking";
const QUESTION_BATCH_ID = "qb-1";
const REQUESTED_AT = "2026-07-03T09:00:00.000Z";

const QUESTIONS: AskQuestionItem[] = [
  askQuestionItemSchema.parse({
    id: "q1",
    question: "Which database?",
    options: [{ label: "Postgres" }, { label: "SQLite" }],
  }),
];

function parkedExecution(
  opts: {
    executionStatus?: GraphWorkflowStatus;
    answered?: boolean;
    /** A second validator lane parked on its own question in the same context. */
    secondLane?: boolean;
  } = {},
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    status: opts.executionStatus ?? "running",
    // A halted fixture carries a resumable reason: the engine's halt event types
    // its reason as non-nullable, so a reasonless halt is unreachable in
    // production, and the lease predicate this gate follows reads that reason.
    ...(opts.executionStatus === "halted"
      ? {
          haltReason: {
            type: "circuit_breaker" as const,
            contextId: PARKED_CONTEXT_ID,
            condition: "retry_exhaustion" as const,
            summary: null,
          },
        }
      : {}),
  });
  const contextState = execution.contextStates[PARKED_CONTEXT_ID];
  if (!contextState) throw new Error("fixture missing parked context");
  contextState.status = "awaiting_user_input";
  contextState.pendingUserInputs = {
    implementer: {
      conversationId: ASKING_CONVERSATION_ID,
      lane: "implementer",
      questionBatchId: QUESTION_BATCH_ID,
      questions: QUESTIONS,
      requestedAt: REQUESTED_AT,
      roundSeq: null,
      answers: opts.answered
        ? { byQuestionId: {}, answeredAt: "2026-07-03T09:05:00.000Z" }
        : null,
    },
    ...(opts.secondLane
      ? {
          "context_validator:security-reviewer": {
            conversationId: "conv-security",
            lane: "context_validator" as const,
            questionBatchId: "qb-security",
            questions: QUESTIONS,
            requestedAt: REQUESTED_AT,
            roundSeq: 2,
            answers: null,
          },
        }
      : {}),
  };
  return execution;
}

function standingFor(
  execution: GraphWorkflowExecution,
  contextId: string | null,
  laneKey: string,
): UserInputStanding {
  const standing = deriveUserInputStandings(execution, contextId).find(
    (entry) => entry.laneKey === laneKey,
  );
  if (!standing) throw new Error(`no standing for lane ${laneKey}`);
  return standing;
}

describe("deriveUserInputStandings", () => {
  it("returns nothing when there is no execution", () => {
    expect(deriveUserInputStandings(null, PARKED_CONTEXT_ID)).toEqual([]);
  });

  it("returns nothing when the contextId is null", () => {
    expect(deriveUserInputStandings(parkedExecution(), null)).toEqual([]);
  });

  it.each(["running", "paused", "halted"] as const)(
    "returns the standing while the execution is %s",
    (executionStatus) => {
      const standings = deriveUserInputStandings(
        parkedExecution({ executionStatus }),
        PARKED_CONTEXT_ID,
      );
      expect(standings).toEqual([
        {
          contextId: PARKED_CONTEXT_ID,
          laneKey: "implementer",
          conversationId: ASKING_CONVERSATION_ID,
          questionBatchId: QUESTION_BATCH_ID,
          questions: QUESTIONS,
        },
      ]);
    },
  );

  it("returns one standing per parked lane, in lane-key order", () => {
    const standings = deriveUserInputStandings(
      parkedExecution({ secondLane: true }),
      PARKED_CONTEXT_ID,
    );
    expect(standings.map((entry) => entry.laneKey)).toEqual([
      "context_validator:security-reviewer",
      "implementer",
    ]);
    expect(standings[1]?.conversationId).toBe(ASKING_CONVERSATION_ID);
    expect(standings[0]?.conversationId).toBe("conv-security");
  });

  it("keeps a sibling's unanswered question standing after one lane is answered", () => {
    const standings = deriveUserInputStandings(
      parkedExecution({ answered: true, secondLane: true }),
      PARKED_CONTEXT_ID,
    );
    expect(standings.map((entry) => entry.laneKey)).toEqual([
      "context_validator:security-reviewer",
    ]);
  });

  it.each(["pending", "completed", "aborted"] as const)(
    "returns nothing when the execution is %s",
    (executionStatus) => {
      expect(
        deriveUserInputStandings(
          parkedExecution({ executionStatus }),
          PARKED_CONTEXT_ID,
        ),
      ).toEqual([]);
    },
  );

  it("drops a lane once answers have been recorded on its record", () => {
    expect(
      deriveUserInputStandings(
        parkedExecution({ answered: true }),
        PARKED_CONTEXT_ID,
      ),
    ).toEqual([]);
  });

  it("returns nothing for a context that is not awaiting user input", () => {
    expect(
      deriveUserInputStandings(
        createWorkflowExecution({ status: "running" }),
        PARKED_CONTEXT_ID,
      ),
    ).toEqual([]);
  });

  it("returns nothing for an unknown context id", () => {
    expect(deriveUserInputStandings(parkedExecution(), "context-nope")).toEqual(
      [],
    );
  });
});

describe("useUserInputGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch() {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes("/answer")) {
          return Response.json({ ok: true });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    return calls;
  }

  function renderGateHook(standing: UserInputStanding) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(
      () =>
        useUserInputGate({
          projectName: "proj",
          sessionName: "sess",
          standing,
        }),
      { wrapper },
    );
  }

  it("returns panel props fed from the lane's pending record", () => {
    stubFetch();
    const { result } = renderGateHook(
      standingFor(parkedExecution(), PARKED_CONTEXT_ID, "implementer"),
    );
    expect(result.current.questions).toEqual(QUESTIONS);
    expect(result.current.questionId).toBe(QUESTION_BATCH_ID);
    expect(result.current.currentIndex).toBe(0);
  });

  it("updates the current question index through onNavigate", () => {
    stubFetch();
    const { result } = renderGateHook(
      standingFor(parkedExecution(), PARKED_CONTEXT_ID, "implementer"),
    );
    act(() => {
      result.current.onNavigate(1);
    });
    expect(result.current.currentIndex).toBe(1);
  });

  it("posts the answer set to the asking conversation's answer endpoint", async () => {
    const calls = stubFetch();
    const { result } = renderGateHook(
      standingFor(parkedExecution(), PARKED_CONTEXT_ID, "implementer"),
    );

    await act(async () => {
      await result.current.onSubmit(QUESTION_BATCH_ID, {
        q1: { selected: ["Postgres"], note: "", skipped: false },
      });
    });

    const answerCall = calls.find((c) => c.url.includes("/answer"));
    expect(answerCall).toBeDefined();
    expect(answerCall?.url).toContain(
      `/api/projects/proj/sessions/sess/conversations/${ASKING_CONVERSATION_ID}/answer`,
    );
    expect(answerCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(answerCall?.init?.body))).toEqual({
      questionId: QUESTION_BATCH_ID,
      answers: {
        q1: { selected: ["Postgres"], note: "", skipped: false },
      },
    });
  });

  it("posts a validator lane's answers to ITS conversation, not the implementer's", async () => {
    const calls = stubFetch();
    const { result } = renderGateHook(
      standingFor(
        parkedExecution({ secondLane: true }),
        PARKED_CONTEXT_ID,
        "context_validator:security-reviewer",
      ),
    );

    await act(async () => {
      await result.current.onSubmit("qb-security", {
        q1: { selected: ["Postgres"], note: "", skipped: false },
      });
    });

    const answerCall = calls.find((c) => c.url.includes("/answer"));
    expect(answerCall?.url).toContain(
      "/api/projects/proj/sessions/sess/conversations/conv-security/answer",
    );
  });
});
