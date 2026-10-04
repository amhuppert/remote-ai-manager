import { describe, expect, it } from "vitest";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { runPromptRequestSchema } from "@/lib/prompt/schemas";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { TurnStream, UserMessageAdmission } from "./executor";
import type { RunCommandOutcome } from "@/lib/conversation-commands/service";
import type { ConversationCommandDispatchInput } from "@/lib/conversation-commands/dispatch";
import {
  projectConversationTarget,
  sessionConversationTarget,
  storeSessionNameFromScopeRef,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { ProjectCollaborationUnsupportedError } from "@/lib/project-conversations/collaboration-refusal";
import { conversationHoldRefusal } from "./conversation-record";
import { admitCoreCollaboration, promptCoreConversation, type CoreConversationPromptDeps } from "./prompt-route";
import type { SeatTurnReport } from "./schemas";

const report = (overrides: Partial<SeatTurnReport> = {}): SeatTurnReport => ({
  status: "succeeded",
  conversationId: "conv-1",
  finalText: "Hi",
  structuredOutput: null,
  outputIssue: null,
  openQuestionId: null,
  failure: null,
  ...overrides,
});

interface Sent {
  conversationId: string;
  text: string;
  images?: unknown;
  documentFeedback?: unknown;
  inputOrigin?: string;
  backend?: string;
  modelSelection?: unknown;
  stream?: TurnStream;
}

const sessionTarget = sessionConversationTarget("repo", "session", "conv-1");
const projectTarget = projectConversationTarget("repo", "conv-1");

function harness(answer: (sent: Sent) => UserMessageAdmission) {
  const sent: Sent[] = [];
  const commands: string[] = [];
  const dispatched: ConversationCommandDispatchInput[] = [];
  const clearedKeys: string[] = [];
  let commandOutcome: RunCommandOutcome = { status: "dispatched", jobId: "job-1", usedFallback: false };
  const cleared: string[] = [];
  const adopted: string[] = [];
  let busy = false;
  let durableHold: { code: "busy" | "owned"; message: string } | null = null;
  const holdsAsked: string[] = [];
  let current = makeConversationState({ agentBackend: "claude" });
  const deps: CoreConversationPromptDeps = {
    // The core's admission over the conversation under test: its running turn, its row, its other holds.
    async admission(_conversationId, turn) {
      holdsAsked.push(turn);
      if (busy && turn !== "task") return { code: "busy", message: "Conversation is busy — a turn is already running" };
      return conversationHoldRefusal(current, turn) ?? durableHold;
    },
    async adoptBackend(_identity, backend) {
      adopted.push(backend);
    },
    async sendUserMessage(input) {
      sent.push(input);
      return answer(input);
    },
    async clearPendingPromptText(_projectPath, storeSessionName, _conversationId, expected) {
      cleared.push(expected);
      clearedKeys.push(storeSessionName);
      return true;
    },
    async dispatchCommand(input) {
      commands.push(`${input.parsed.command}:${input.rawText}`);
      dispatched.push(input);
      return commandOutcome;
    },
    commandRefusal: async () => null,
    log: createCapturingLogger(),
  };
  const prompt = (
    body: unknown,
    conversation = makeConversationState({ agentBackend: "claude" }),
    target: ConversationTarget = sessionTarget,
  ) => {
    current = conversation;
    return promptCoreConversation(deps, {
      projectPath: "/repo",
      target,
      conversation,
      body: runPromptRequestSchema.parse(body),
    });
  };
  return {
    deps,
    prompt,
    sent,
    cleared,
    clearedKeys,
    commands,
    dispatched,
    adopted,
    setBusy(value: boolean) {
      busy = value;
    },
    holdsAsked,
    setDurableHold(value: { code: "busy" | "owned"; message: string } | null) {
      durableHold = value;
    },
    setCommandOutcome(outcome: RunCommandOutcome) {
      commandOutcome = outcome;
    },
  };
}

/** The server-sent events of a finished response, in order. */
async function eventsOf(response: Response): Promise<[string, unknown][]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [eventLine = "", dataLine = ""] = chunk.split("\n");
      return [eventLine.replace("event: ", ""), JSON.parse(dataLine.replace("data: ", ""))];
    });
}

describe("prompting a conversation the core runs", () => {
  it("streams the turn to the sender, clears their draft once accepted, and ends when the turn settles", async () => {
    const h = harness((sent) => {
      sent.stream?.emit("content", { type: "text", text: "Hi" });
      return { kind: "accepted", cause: "user:conv-1:1", settled: Promise.resolve(report()) };
    });
    const response = await h.prompt({ prompt: "  Hello  ", submittedPendingPromptText: "Hello" });

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await eventsOf(response)).toEqual([
      ["content", { type: "text", text: "Hi" }],
      ["done", {}],
    ]);
    expect(h.sent[0]).toMatchObject({ conversationId: "conv-1", text: "Hello" });
    expect(h.cleared).toEqual(["Hello"]);
  });

  it("tells the sender why a message that never ran ended", async () => {
    const h = harness(() => ({
      kind: "accepted",
      cause: "user:conv-1:1",
      settled: Promise.resolve(report({ status: "cancelled", finalText: null, failure: "cancelled before admission" })),
    }));
    expect(await eventsOf(await h.prompt({ prompt: "Hello" }))).toEqual([
      ["aborted", { message: "cancelled before admission" }],
      ["done", {}],
    ]);
  });

  it("does not repeat an ending the turn already reported", async () => {
    const h = harness((sent) => {
      sent.stream?.emit("error", { message: "SDK transport closed" });
      return {
        kind: "accepted",
        cause: "user:conv-1:1",
        settled: Promise.resolve(report({ status: "failed", finalText: null, failure: "SDK transport closed" })),
      };
    });
    expect(await eventsOf(await h.prompt({ prompt: "Hello" }))).toEqual([
      ["error", { message: "SDK transport closed" }],
      ["done", {}],
    ]);
  });

  it("answers a busy conversation with a conflict and no stream", async () => {
    const h = harness(() => ({ kind: "refused", code: "busy", message: "Conversation is busy — a turn is already running" }));
    const response = await h.prompt({ prompt: "Hello" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CONVERSATION_BUSY" });
    expect(h.cleared).toEqual([]);
  });

  it("answers each admission refusal with its own code, before clearing the draft", async () => {
    for (const [code, expected] of [
      ["queue_review", "QUEUE_REVIEW_REQUIRED"],
      ["debug_mode", "DEBUG_MODE_ACTIVE"],
      ["stopping", "SERVER_STOPPING"],
    ] as const) {
      const h = harness(() => ({ kind: "refused", code, message: "Held" }));
      const response = await h.prompt({ prompt: "Hello" });
      expect(await response.json()).toMatchObject({ code: expected, error: "Held" });
      expect(h.cleared).toEqual([]);
    }
  });

  it("refuses a seat conversation, which takes work only from its run", async () => {
    const h = harness(() => ({ kind: "accepted", cause: "c", settled: Promise.resolve(report()) }));
    const response = await h.prompt({ prompt: "Hello" }, makeConversationState({ role: "validator" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "MANAGED_CONVERSATION" });
    expect(h.sent).toEqual([]);
  });

  it("sends a message's images and review feedback to the core with it", async () => {
    const h = harness(() => ({ kind: "accepted", cause: "c", settled: Promise.resolve(report()) }));
    const image = { attachmentId: "img-1", mediaType: "image/png" as const, base64Data: "aGk=" };
    await eventsOf(await h.prompt({ prompt: "", images: [image] }));
    const documentFeedback = {
      items: [{ docPath: "docs/plan.md", path: "docs/plan.md", headingLabel: "Rollout", line: 3, quote: "Ship", note: "Too early" }],
    };
    await eventsOf(await h.prompt({ prompt: "", documentFeedback }));

    expect(h.sent[0]).toMatchObject({ text: "", images: [image], inputOrigin: "user" });
    expect(h.sent[1]).toMatchObject({ text: "", documentFeedback, inputOrigin: "generated" });
  });

  it("runs a conversation command through the command service and ends the stream when it is done", async () => {
    const h = harness(() => ({ kind: "accepted", cause: "c", settled: Promise.resolve(report()) }));
    const response = await h.prompt({ prompt: "/commit tidy the notices", submittedPendingPromptText: "/commit tidy the notices" });

    expect(await eventsOf(response)).toEqual([["done", {}]]);
    expect(h.commands).toEqual(["commit:/commit tidy the notices"]);
    expect(h.sent).toEqual([]);
    expect(h.cleared).toEqual(["/commit tidy the notices"]);
  });

  it("refuses what core conversations cannot do yet, before sending anything", async () => {
    const h = harness(() => ({ kind: "accepted", cause: "c", settled: Promise.resolve(report()) }));
    for (const body of [{ prompt: "/collab build it" }]) {
      const response = await h.prompt(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "CORE_CONVERSATION_UNSUPPORTED" });
    }
    expect(h.sent).toEqual([]);
  });

  it("hands the backend a fresh conversation's sender chose to the turn, and refuses a change once it has run", async () => {
    const h = harness(() => ({ kind: "accepted", cause: "c", settled: Promise.resolve(report()) }));
    await eventsOf(await h.prompt({ prompt: "Hello", backend: "codex" }));
    expect(h.sent[0]).toMatchObject({ backend: "codex" });
    // An explicit choice travels even when it matches what this request saw:
    // the turn, not a possibly stale snapshot, decides.
    await eventsOf(await h.prompt({ prompt: "Hello", backend: "claude" }));
    expect(h.sent[1]).toMatchObject({ backend: "claude" });

    const used = makeConversationState({ agentBackend: "claude", promptCount: 1 });
    const response = await h.prompt({ prompt: "Hello", backend: "codex" }, used);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "BACKEND_MISMATCH" });
    expect(h.sent).toHaveLength(2);
  });

  describe("in a project conversation", () => {
    it("clears the person's draft under the project conversation's storage key", async () => {
      const h = harness(() => ({ kind: "accepted", cause: "c", settled: Promise.resolve(report()) }));
      await eventsOf(await h.prompt({ prompt: "Hello" }, undefined, projectTarget));
      await eventsOf(await h.prompt({ prompt: "Hello" }));

      expect(h.clearedKeys).toEqual([storeSessionNameFromScopeRef({ scope: "project" }), "session"]);
    });

    it("runs a command with no session worktree, its notices addressed to the project conversation", async () => {
      const h = harness(() => ({ kind: "accepted", cause: "c", settled: Promise.resolve(report()) }));
      await eventsOf(await h.prompt({ prompt: "/commit tidy" }, undefined, projectTarget));
      await eventsOf(await h.prompt({ prompt: "/commit tidy" }));

      expect(h.dispatched[0]).toMatchObject({ projectName: "repo", sessionName: null, conversationId: "conv-1" });
      expect(h.dispatched[0]?.noticeSessionName).toBe(storeSessionNameFromScopeRef({ scope: "project" }));
      expect(h.dispatched[1]).toMatchObject({ projectName: "repo", sessionName: "session" });
      expect(h.dispatched[1]).not.toHaveProperty("noticeSessionName");
    });

    it("refuses /collab the way a project conversation always has, before sending anything", async () => {
      const h = harness(() => ({ kind: "accepted", cause: "c", settled: Promise.resolve(report()) }));
      const response = await h.prompt({ prompt: "/collab build it" }, undefined, projectTarget);

      expect(response.status).toBe(400);
      const refusal = new ProjectCollaborationUnsupportedError();
      expect(await response.json()).toEqual({ error: refusal.message, code: refusal.code });
      expect(h.sent).toEqual([]);
      expect(h.cleared).toEqual([]);
    });
  });

  it("answers a collaboration's hold on the conversation as owned", async () => {
    const h = harness(() => ({ kind: "refused", code: "owned", message: "A collaboration is working in this conversation" }));
    const response = await h.prompt({ prompt: "Hello" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CONVERSATION_OWNED" });
  });

  describe("a conversation command", () => {
    const pendingReview = {
      id: "q-1",
      content: [{ type: "text" as const, text: "Earlier" }],
      status: "failed" as const,
      enqueuedAt: "2026-10-03T10:00:00.000Z",
      updatedAt: "2026-10-03T10:00:00.000Z",
      deliveryStartedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      failedAt: "2026-10-03T10:00:01.000Z",
      deliveryAttemptId: "att-1",
      attemptCount: 1,
      error: "Stopped before it was sent",
    };

    it("is held where a message would be: queue review, debug mode, a running turn, a collaboration's claim", async () => {
      const h = harness(() => ({ kind: "accepted", cause: "c", settled: new Promise(() => {}) }));
      const refusedWith = async (conversation: ReturnType<typeof makeConversationState>) => {
        const response = await h.prompt({ prompt: "/commit" }, conversation);
        expect(response.status).toBe(409);
        return ((await response.json()) as { code?: string }).code;
      };
      expect(await refusedWith(makeConversationState({ pendingQueue: [pendingReview] }))).toBe("QUEUE_REVIEW_REQUIRED");
      expect(
        await refusedWith(
          makeConversationState({
            debugMode: {
              active: true,
              recording: true,
              logFilePath: "/w/log",
              enteredAt: "2026-10-03T10:00:00.000Z",
              hypotheses: [],
              reproductionSteps: [],
              fixSummary: null,
              verificationSteps: [],
              instructionsDelivered: true,
              phase: "awaiting_reproduction",
              lastTurnFailed: false,
              debugSessionId: "dbg-1",
            },
          }),
        ),
      ).toBe("DEBUG_MODE_ACTIVE");
      expect(
        await refusedWith(makeConversationState({ owner: { kind: "collaboration", workflowId: "wf-1", attemptEpoch: 1 } })),
      ).toBe("CONVERSATION_OWNED");
      h.setBusy(true);
      expect(await refusedWith(makeConversationState({}))).toBe("CONVERSATION_BUSY");
      expect(h.commands).toEqual([]);
    });

    it("is held by a durable hold the core keeps", async () => {
      const h = harness(() => ({ kind: "accepted", cause: "c", settled: new Promise(() => {}) }));
      h.setDurableHold({ code: "busy", message: "Conversation checkpoint maintenance is in progress" });
      const response = await h.prompt({ prompt: "/rebase" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "CONVERSATION_BUSY", error: "Conversation checkpoint maintenance is in progress" });
      expect(h.holdsAsked).toEqual(["command"]);
      expect(h.commands).toEqual([]);
    });

    it("adopts the backend a fresh conversation's first command chose before it runs", async () => {
      const h = harness(() => ({ kind: "accepted", cause: "c", settled: new Promise(() => {}) }));
      const response = await h.prompt(
        { prompt: "/commit", backend: "codex" },
        makeConversationState({ agentBackend: "claude", promptCount: 0, backendRef: null }),
      );
      await response.text();
      expect(h.adopted).toEqual(["codex"]);
      expect(h.commands).toEqual(["commit:/commit"]);
    });
  });

  describe("a /collab claim", () => {
    const admit = (h: ReturnType<typeof harness>, conversation: ReturnType<typeof makeConversationState>, backend?: string) =>
      admitCoreCollaboration(h.deps, {
        projectPath: "/repo",
        target: sessionTarget,
        conversation,
        body: runPromptRequestSchema.parse({ prompt: "/collab design it", ...(backend !== undefined ? { backend } : {}) }),
      });

    it("asks the core's holds as a claim, and a fresh conversation takes the backend it chose", async () => {
      const h = harness(() => ({ kind: "accepted", cause: "c", settled: new Promise(() => {}) }));
      expect(await admit(h, makeConversationState({ agentBackend: "claude", promptCount: 0, backendRef: null }), "codex")).toBeNull();
      expect(h.holdsAsked).toEqual(["claim"]);
      expect(h.adopted).toEqual(["codex"]);
    });

    it("refuses a backend change on a conversation that has run, and a claim the core holds", async () => {
      const h = harness(() => ({ kind: "accepted", cause: "c", settled: new Promise(() => {}) }));
      const mismatch = await admit(h, makeConversationState({ agentBackend: "claude", promptCount: 3 }), "codex");
      expect(mismatch?.status).toBe(409);
      expect(await mismatch?.json()).toMatchObject({ code: "BACKEND_MISMATCH" });

      h.setDurableHold({ code: "busy", message: "A ready checkpoint is delivered by the next ordinary conversation turn" });
      const held = await admit(h, makeConversationState({ agentBackend: "claude" }));
      expect(held?.status).toBe(409);
      expect(h.adopted).toEqual([]);
    });
  });
});
