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
  deriveUserInputStanding,
  useUserInputGate,
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
  } = {},
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    status: opts.executionStatus ?? "running",
  });
  const contextState = execution.contextStates[PARKED_CONTEXT_ID];
  if (!contextState) throw new Error("fixture missing parked context");
  contextState.status = "awaiting_user_input";
  contextState.pendingUserInput = {
    conversationId: ASKING_CONVERSATION_ID,
    lane: "implementer",
    questionBatchId: QUESTION_BATCH_ID,
    questions: QUESTIONS,
    requestedAt: REQUESTED_AT,
    answers: opts.answered
      ? { byQuestionId: {}, answeredAt: "2026-07-03T09:05:00.000Z" }
      : null,
  };
  return execution;
}

describe("deriveUserInputStanding", () => {
  it("returns null when there is no execution", () => {
    expect(deriveUserInputStanding(null, PARKED_CONTEXT_ID)).toBeNull();
  });

  it("returns null when the contextId is null", () => {
    expect(deriveUserInputStanding(parkedExecution(), null)).toBeNull();
  });

  it.each(["running", "paused", "halted"] as const)(
    "returns the standing while the execution is %s",
    (executionStatus) => {
      const standing = deriveUserInputStanding(
        parkedExecution({ executionStatus }),
        PARKED_CONTEXT_ID,
      );
      expect(standing).toEqual({
        contextId: PARKED_CONTEXT_ID,
        conversationId: ASKING_CONVERSATION_ID,
        questionBatchId: QUESTION_BATCH_ID,
        questions: QUESTIONS,
      });
    },
  );

  it.each(["pending", "completed", "aborted"] as const)(
    "returns null when the execution is %s",
    (executionStatus) => {
      expect(
        deriveUserInputStanding(
          parkedExecution({ executionStatus }),
          PARKED_CONTEXT_ID,
        ),
      ).toBeNull();
    },
  );

  it("returns null once answers have been recorded on the record", () => {
    expect(
      deriveUserInputStanding(
        parkedExecution({ answered: true }),
        PARKED_CONTEXT_ID,
      ),
    ).toBeNull();
  });

  it("returns null for a context that is not awaiting user input", () => {
    expect(
      deriveUserInputStanding(
        createWorkflowExecution({ status: "running" }),
        PARKED_CONTEXT_ID,
      ),
    ).toBeNull();
  });

  it("returns null for an unknown context id", () => {
    expect(
      deriveUserInputStanding(parkedExecution(), "context-nope"),
    ).toBeNull();
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

  function renderGateHook(args: {
    execution: GraphWorkflowExecution | null;
    contextId?: string | null;
  }) {
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
          execution: args.execution,
          contextId:
            args.contextId === undefined ? PARKED_CONTEXT_ID : args.contextId,
        }),
      { wrapper },
    );
  }

  it("returns null when the selected context is not parked", () => {
    stubFetch();
    const { result } = renderGateHook({ execution: null });
    expect(result.current).toBeNull();
  });

  it("returns panel props fed from the pending record", () => {
    stubFetch();
    const { result } = renderGateHook({ execution: parkedExecution() });
    expect(result.current).not.toBeNull();
    expect(result.current?.questions).toEqual(QUESTIONS);
    expect(result.current?.questionId).toBe(QUESTION_BATCH_ID);
    expect(result.current?.currentIndex).toBe(0);
  });

  it("updates the current question index through onNavigate", () => {
    stubFetch();
    const { result } = renderGateHook({ execution: parkedExecution() });
    act(() => {
      result.current?.onNavigate(1);
    });
    expect(result.current?.currentIndex).toBe(1);
  });

  it("resets the current question index when the selected context changes", () => {
    stubFetch();
    const execution = parkedExecution();
    // Park a second context so switching keeps a live standing to observe.
    const verify = execution.contextStates["context-verify"];
    if (!verify) throw new Error("fixture missing second context");
    verify.status = "awaiting_user_input";
    verify.pendingUserInput = {
      conversationId: "conv-verify",
      lane: "context_validator",
      questionBatchId: "qb-verify",
      questions: QUESTIONS,
      requestedAt: REQUESTED_AT,
      answers: null,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ contextId }: { contextId: string }) =>
        useUserInputGate({
          projectName: "proj",
          sessionName: "sess",
          execution,
          contextId,
        }),
      { wrapper, initialProps: { contextId: PARKED_CONTEXT_ID } },
    );

    act(() => {
      result.current?.onNavigate(1);
    });
    expect(result.current?.currentIndex).toBe(1);

    rerender({ contextId: "context-verify" });
    expect(result.current?.questionId).toBe("qb-verify");
    expect(result.current?.currentIndex).toBe(0);
  });

  it("posts the answer set to the asking conversation's answer endpoint", async () => {
    const calls = stubFetch();
    const { result } = renderGateHook({ execution: parkedExecution() });

    await act(async () => {
      await result.current?.onSubmit(QUESTION_BATCH_ID, {
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
});
