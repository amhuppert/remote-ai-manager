// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import DebugActionCard from "@/features/session/debug/DebugActionCard";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { DebugModePhase } from "@/lib/debug-log/schemas";
function makeConversation(
  phase: DebugModePhase,
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conv-1",
    name: null,
    transcriptPath: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: {
      active: true,
      recording: true,
      logFilePath: "/tmp/.debug/x.jsonl",
      enteredAt: "2024-01-01T00:00:00Z",
      hypotheses: [],
      reproductionSteps: [],
      instructionsDelivered: true,
      phase,
      fixSummary: null,
      verificationSteps: [],
      lastTurnFailed: false,
    },
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    ...overrides,
  };
}

describe("DebugActionCard button visibility", () => {
  it("shows only 'Mark Reproduced' (and Exit) in awaiting_reproduction", () => {
    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={makeConversation("awaiting_reproduction")}
        onSendPrompt={vi.fn().mockResolvedValue(undefined)}
        isBusy={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Exit Debug" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Mark Reproduced" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Mark Fix Failed" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark Fixed" })).toBeNull();
  });

  it("shows 'Mark Fixed' and 'Mark Fix Failed' (and Exit) in awaiting_verification — not 'Mark Reproduced'", () => {
    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={makeConversation("awaiting_verification")}
        onSendPrompt={vi.fn().mockResolvedValue(undefined)}
        isBusy={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Exit Debug" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark Fixed" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Mark Fix Failed" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Mark Reproduced" }),
    ).toBeNull();
  });

  it("shows neither phase button in hypothesizing", () => {
    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={makeConversation("hypothesizing")}
        onSendPrompt={vi.fn().mockResolvedValue(undefined)}
        isBusy={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Exit Debug" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Mark Reproduced" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Mark Fix Failed" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark Fixed" })).toBeNull();
  });
});

describe("DebugActionCard Mark Fix Failed dispatch", () => {
  let phaseCalls: string[];

  beforeEach(() => {
    phaseCalls = [];
    globalThis.fetch = vi.fn().mockImplementation((_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      phaseCalls.push(body.action);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches mark_fix_failed and sends the re-hypothesize prompt with the prior fixSummary recapped", async () => {
    const onSendPrompt = vi.fn().mockResolvedValue(undefined);
    const conversation = makeConversation("awaiting_verification", {
      debugMode: {
        active: true,
        recording: true,
        logFilePath: "/tmp/.debug/x.jsonl",
        enteredAt: "2024-01-01T00:00:00Z",
        hypotheses: [],
        reproductionSteps: [],
        instructionsDelivered: true,
        phase: "awaiting_verification",
        fixSummary:
          "Replaced the off-by-one in pageOffset with a clamp at zero.",
        verificationSteps: ["Reload the page", "Scroll to bottom"],
        lastTurnFailed: false,
      },
    });
    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={conversation}
        onSendPrompt={onSendPrompt}
        isBusy={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark Fix Failed" }));

    await waitFor(() => expect(phaseCalls).toEqual(["mark_fix_failed"]));
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    const sent = (onSendPrompt.mock.calls[0]?.[0] ?? "") as string;
    expect(sent).toMatch(/did NOT actually resolve/i);
    expect(sent).toMatch(/hypotheses/);
    expect(sent).toContain(
      "Replaced the off-by-one in pageOffset with a clamp at zero.",
    );
  });

  it("omits the fix recap when no prior fixSummary is recorded", async () => {
    const onSendPrompt = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={makeConversation("awaiting_verification")}
        onSendPrompt={onSendPrompt}
        isBusy={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark Fix Failed" }));

    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    const sent = (onSendPrompt.mock.calls[0]?.[0] ?? "") as string;
    expect(sent).not.toMatch(/The fix you previously applied was:/);
    expect(sent).toMatch(/did NOT actually resolve/i);
  });

  it("rolls back to awaiting_verification when the prompt send fails after Mark Fix Failed", async () => {
    const onSendPrompt = vi
      .fn()
      .mockRejectedValue(new Error("prompt send failed"));

    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={makeConversation("awaiting_verification")}
        onSendPrompt={onSendPrompt}
        isBusy={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark Fix Failed" }));

    await waitFor(() =>
      expect(phaseCalls).toEqual([
        "mark_fix_failed",
        "revert_to_awaiting_verification",
      ]),
    );
    expect(onSendPrompt).toHaveBeenCalledTimes(1);
  });
});

describe("DebugActionCard Strategy B rollback", () => {
  let phaseCalls: string[];

  beforeEach(() => {
    phaseCalls = [];
    globalThis.fetch = vi.fn().mockImplementation((_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      phaseCalls.push(body.action);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rolls back to awaiting_reproduction when the prompt send fails after Mark Reproduced", async () => {
    const onSendPrompt = vi
      .fn()
      .mockRejectedValue(new Error("prompt send failed"));

    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={makeConversation("awaiting_reproduction")}
        onSendPrompt={onSendPrompt}
        isBusy={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark Reproduced" }));

    await waitFor(() =>
      expect(phaseCalls).toEqual([
        "mark_reproduced",
        "revert_to_awaiting_reproduction",
      ]),
    );
    expect(onSendPrompt).toHaveBeenCalledTimes(1);
  });

  it("rolls back to awaiting_verification when the prompt send fails after Mark Fixed", async () => {
    const onSendPrompt = vi
      .fn()
      .mockRejectedValue(new Error("prompt send failed"));

    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={makeConversation("awaiting_verification")}
        onSendPrompt={onSendPrompt}
        isBusy={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark Fixed" }));

    await waitFor(() =>
      expect(phaseCalls).toEqual([
        "mark_fix_verified",
        "revert_to_awaiting_verification",
      ]),
    );
    expect(onSendPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not roll back when the prompt send succeeds", async () => {
    const onSendPrompt = vi.fn().mockResolvedValue(undefined);

    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={makeConversation("awaiting_reproduction")}
        onSendPrompt={onSendPrompt}
        isBusy={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark Reproduced" }));

    await waitFor(() => expect(phaseCalls).toEqual(["mark_reproduced"]));
    expect(onSendPrompt).toHaveBeenCalledTimes(1);
  });
});

describe("DebugActionCard Retry CTA", () => {
  let phaseCalls: string[];

  beforeEach(() => {
    phaseCalls = [];
    globalThis.fetch = vi.fn().mockImplementation((_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      phaseCalls.push(body.action);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not show Retry when lastTurnFailed is false", () => {
    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={makeConversation("hypothesizing")}
        onSendPrompt={vi.fn().mockResolvedValue(undefined)}
        isBusy={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows Retry when the conversation is in the debug error sub-state", () => {
    const conversation = makeConversation("hypothesizing", {
      debugMode: {
        active: true,
        recording: true,
        logFilePath: "/tmp/.debug/x.jsonl",
        enteredAt: "2024-01-01T00:00:00Z",
        hypotheses: [],
        reproductionSteps: [],
        instructionsDelivered: true,
        phase: "hypothesizing",
        fixSummary: null,
        verificationSteps: [],
        lastTurnFailed: true,
      },
    });

    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={conversation}
        onSendPrompt={vi.fn().mockResolvedValue(undefined)}
        isBusy={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("dispatches retry_turn when Retry is clicked", async () => {
    const conversation = makeConversation("analyzing_evidence", {
      debugMode: {
        active: true,
        recording: true,
        logFilePath: "/tmp/.debug/x.jsonl",
        enteredAt: "2024-01-01T00:00:00Z",
        hypotheses: [],
        reproductionSteps: [],
        instructionsDelivered: true,
        phase: "analyzing_evidence",
        fixSummary: null,
        verificationSteps: [],
        lastTurnFailed: true,
      },
    });

    const onSendPrompt = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={conversation}
        onSendPrompt={onSendPrompt}
        isBusy={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(phaseCalls).toEqual(["retry_turn"]));
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it("hides phase action buttons when lastTurnFailed is true", () => {
    const conversation = makeConversation("awaiting_reproduction", {
      debugMode: {
        active: true,
        recording: true,
        logFilePath: "/tmp/.debug/x.jsonl",
        enteredAt: "2024-01-01T00:00:00Z",
        hypotheses: [],
        reproductionSteps: [],
        instructionsDelivered: true,
        phase: "awaiting_reproduction",
        fixSummary: null,
        verificationSteps: [],
        lastTurnFailed: true,
      },
    });

    renderWithQuery(
      <DebugActionCard
        projectName="p"
        sessionName="s"
        conversation={conversation}
        onSendPrompt={vi.fn().mockResolvedValue(undefined)}
        isBusy={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Mark Reproduced" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit Debug" })).toBeTruthy();
  });
});
