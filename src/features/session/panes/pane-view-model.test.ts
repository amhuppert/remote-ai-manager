import { describe, expect, it } from "vitest";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import { summarizeMessage, toPaneViewModel } from "./pane-view-model";

function makeConversation(
  overrides: Partial<SessionActiveConversation> = {},
): SessionActiveConversation {
  return {
    scope: "session",
    id: "conv-1",
    name: "My conversation",
    status: "running",
    lastActivityAt: "2026-06-14T12:00:00.000Z",
    projectName: "command-center",
    projectPath: "/repos/command-center",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/repos/command-center/.worktrees/x",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    sessionName: "tabs-split",
    branchName: "csm/tabs-split",
    ...overrides,
  };
}

describe("toPaneViewModel", () => {
  it("maps every display field with a deterministic relative time", () => {
    const lastActivityAt = "2026-06-14T12:00:00.000Z";
    const now = Date.parse(lastActivityAt) + 5 * 60_000;
    const conversation = makeConversation({
      id: "conv-42",
      name: "Refactor the grid",
      status: "running",
      projectName: "command-center",
      sessionName: "tabs-split",
      lastActivityAt,
      pendingQuestion: null,
      lastActivitySummary: "Editing pane-view-model.ts",
    });

    expect(toPaneViewModel(conversation, now)).toEqual({
      id: "conv-42",
      title: "Refactor the grid",
      status: "running",
      projectName: "command-center",
      sessionName: "tabs-split",
      pendingQuestion: null,
      statusLine: "Editing pane-view-model.ts",
      relativeTime: "5m ago",
    });
  });

  it("falls back to an Untitled title when name is null", () => {
    const vm = toPaneViewModel(makeConversation({ name: null }));
    expect(vm.title).toBe("Untitled conversation");
  });

  it("falls back to an Untitled title when name is blank whitespace", () => {
    const vm = toPaneViewModel(makeConversation({ name: "   " }));
    expect(vm.title).toBe("Untitled conversation");
  });

  it("passes through the pending question for a waiting conversation", () => {
    const vm = toPaneViewModel(
      makeConversation({
        status: "waiting_for_input",
        pendingQuestion: "Which approach should I take?",
        lastActivitySummary: "Waiting on your answer",
      }),
    );
    expect(vm.pendingQuestion).toBe("Which approach should I take?");
    expect(vm.status).toBe("waiting_for_input");
  });

  it("passes through the latest status line", () => {
    const vm = toPaneViewModel(
      makeConversation({ lastActivitySummary: "Ran the test suite" }),
    );
    expect(vm.statusLine).toBe("Ran the test suite");
  });

  it("carries a null status line through unchanged", () => {
    const vm = toPaneViewModel(makeConversation({ lastActivitySummary: null }));
    expect(vm.statusLine).toBeNull();
  });

  it("formats hours and days relative times", () => {
    const lastActivityAt = "2026-06-14T00:00:00.000Z";
    const base = Date.parse(lastActivityAt);
    expect(
      toPaneViewModel(
        makeConversation({ lastActivityAt }),
        base + 3 * 3_600_000,
      ).relativeTime,
    ).toBe("3h ago");
    expect(
      toPaneViewModel(
        makeConversation({ lastActivityAt }),
        base + 2 * 86_400_000,
      ).relativeTime,
    ).toBe("2d ago");
  });
});

describe("summarizeMessage", () => {
  it("summarizes a plain user text message as a 'you' row with no tool", () => {
    const message: TranscriptMessage = {
      role: "user",
      content: [{ type: "text", text: "  Please refactor this  " }],
      timestamp: null,
    };
    expect(summarizeMessage(message)).toEqual({
      role: "you",
      text: "Please refactor this",
      tool: undefined,
    });
  });

  it("summarizes an assistant message with a tool call as a 'cc' row with a tool line", () => {
    const message: TranscriptMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Reading the file now" },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/repos/x/pane-view-model.ts" },
        },
      ],
      timestamp: null,
    };

    const result = summarizeMessage(message);
    expect(result.role).toBe("cc");
    expect(result.text).toBe("Reading the file now");
    expect(result.tool?.name).toBe("Read");
    expect(result.tool?.detail).toContain("file_path");
    expect(result.tool?.detail).toContain("/repos/x/pane-view-model.ts");
    expect(result.tool?.detail).not.toMatch(/\n/);
  });

  it("groups notice messages on the cc side", () => {
    const message: TranscriptMessage = {
      role: "notice",
      content: [{ type: "text", text: "Conversation forked" }],
      timestamp: null,
    };
    expect(summarizeMessage(message).role).toBe("cc");
  });

  it("returns an empty text when no text block is present", () => {
    const message: TranscriptMessage = {
      role: "assistant",
      content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
      timestamp: null,
    };
    const result = summarizeMessage(message);
    expect(result.text).toBe("");
    expect(result.tool).toEqual({ name: "Bash", detail: '{"command":"ls"}' });
  });

  it("uses an empty detail when a tool call has no input", () => {
    const message: TranscriptMessage = {
      role: "assistant",
      content: [{ type: "tool_use", name: "TodoWrite" }],
      timestamp: null,
    };
    expect(summarizeMessage(message).tool).toEqual({
      name: "TodoWrite",
      detail: "",
    });
  });

  it("collapses multiline / multispace input into a single line detail", () => {
    const message: TranscriptMessage = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "Write",
          input: { content: "line one\nline   two" },
        },
      ],
      timestamp: null,
    };
    const detail = summarizeMessage(message).tool?.detail ?? "";
    expect(detail).not.toMatch(/\n/);
    expect(detail).not.toMatch(/ {2,}/);
  });
});
