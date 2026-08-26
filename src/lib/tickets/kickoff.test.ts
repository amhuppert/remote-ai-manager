import { describe, expect, it, vi } from "vitest";
import type { DispatchFirstTurnInput } from "@/lib/prompt/first-turn-dispatch";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  createTicketKickoffQueuer,
  type TicketKickoffQueuerDeps,
} from "./kickoff";
import type { TicketKickoffInput } from "./start-service";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const SESSION = {
  sessionName: "ticket-12-fix-the-gate-1",
  conversations: [{ id: "conv-1" }],
} as unknown as SessionState;

const KICKOFF: TicketKickoffInput = {
  projectPath: "/repos/demo",
  projectName: "demo",
  sessionName: "ticket-12-fix-the-gate-1",
  conversationId: "conv-1",
  ticketIdentifier: "demo#12",
  prompt: "You are starting work on ticket demo#12: Fix the gate",
  backend: "codex",
  modelSelection: {
    modelId: "gpt-5.6-sol",
    parameters: { fast: "true", reasoning: "ultra" },
  },
};

interface Recorded {
  dispatches: DispatchFirstTurnInput[];
  notices: Array<{
    conversationId: string;
    text: string;
    projectName: string;
    storeSessionName: string;
  }>;
}

function makeQueuer(overrides: Partial<TicketKickoffQueuerDeps> = {}): {
  queuer: ReturnType<typeof createTicketKickoffQueuer>;
  recorded: Recorded;
} {
  const recorded: Recorded = { dispatches: [], notices: [] };
  const deps: TicketKickoffQueuerDeps = {
    getSession() {
      return Promise.resolve(SESSION);
    },
    dispatchFirstTurn(input) {
      recorded.dispatches.push(input);
      return Promise.resolve({ dispatched: true });
    },
    appendNotice(input) {
      recorded.notices.push(input);
      return Promise.resolve();
    },
    getDefaultAgentBackend() {
      return Promise.resolve("codex");
    },
    ...overrides,
  };
  return { queuer: createTicketKickoffQueuer(deps), recorded };
}

describe("createTicketKickoffQueuer", () => {
  it("declines to queue when the session row is missing, dispatching nothing", async () => {
    const { queuer, recorded } = makeQueuer({
      getSession() {
        return Promise.resolve(null);
      },
    });

    await expect(queuer.queueKickoff(KICKOFF)).resolves.toBe(false);
    expect(recorded.dispatches).toEqual([]);
    expect(recorded.notices).toEqual([]);
  });

  it("queues the first turn with the selected backend and complete model selection", async () => {
    let settle!: (result: { dispatched: boolean }) => void;
    const turn = new Promise<{ dispatched: boolean }>((resolve) => {
      settle = resolve;
    });
    const { queuer, recorded } = makeQueuer({
      dispatchFirstTurn(input) {
        recorded.dispatches.push(input);
        return turn;
      },
    });

    // The dispatcher resolves only when the whole first turn completes, so
    // queueKickoff must report queued while the turn is still in flight.
    await expect(queuer.queueKickoff(KICKOFF)).resolves.toBe(true);
    expect(recorded.dispatches).toHaveLength(1);
    expect(recorded.dispatches[0]).toMatchObject({
      projectPath: KICKOFF.projectPath,
      projectName: KICKOFF.projectName,
      session: SESSION,
      initialPrompt: KICKOFF.prompt,
      agent: "codex",
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { fast: "true", reasoning: "ultra" },
      },
    });
    settle({ dispatched: true });
  });

  it("appends no notice when the dispatch completes", async () => {
    const { queuer, recorded } = makeQueuer();

    await queuer.queueKickoff(KICKOFF);
    await vi.waitFor(() => {
      expect(recorded.dispatches).toHaveLength(1);
    });
    // Let the settle chain flush before asserting silence.
    await Promise.resolve();
    await Promise.resolve();

    expect(recorded.notices).toEqual([]);
  });

  it("surfaces a declined dispatch as a durable notice in the kickoff conversation", async () => {
    const { queuer, recorded } = makeQueuer({
      dispatchFirstTurn(input) {
        recorded.dispatches.push(input);
        return Promise.resolve({ dispatched: false });
      },
    });

    await expect(queuer.queueKickoff(KICKOFF)).resolves.toBe(true);

    await vi.waitFor(() => {
      expect(recorded.notices).toHaveLength(1);
    });
    expect(recorded.notices[0]).toMatchObject({
      conversationId: KICKOFF.conversationId,
      projectName: KICKOFF.projectName,
      storeSessionName: KICKOFF.sessionName,
    });
    expect(recorded.notices[0]?.text).toContain("demo#12");
    expect(recorded.notices[0]?.text).toContain("kickoff");
  });

  it("surfaces a dispatch rejection as a notice carrying the failure reason", async () => {
    const { queuer, recorded } = makeQueuer({
      dispatchFirstTurn() {
        return Promise.reject(new Error("backend unavailable"));
      },
    });

    await expect(queuer.queueKickoff(KICKOFF)).resolves.toBe(true);

    await vi.waitFor(() => {
      expect(recorded.notices).toHaveLength(1);
    });
    expect(recorded.notices[0]?.text).toContain("backend unavailable");
  });

  it("swallows a notice-append failure without an unhandled rejection", async () => {
    const noticeAttempts: string[] = [];
    const { queuer } = makeQueuer({
      dispatchFirstTurn() {
        return Promise.resolve({ dispatched: false });
      },
      appendNotice(input) {
        noticeAttempts.push(input.conversationId);
        return Promise.reject(new Error("transcript locked"));
      },
    });

    await expect(queuer.queueKickoff(KICKOFF)).resolves.toBe(true);
    // Vitest fails the run on unhandled rejections, so flushing the settle
    // chain here is the assertion that the failure was contained.
    await vi.waitFor(() => {
      expect(noticeAttempts).toEqual([KICKOFF.conversationId]);
    });
    await Promise.resolve();
    await Promise.resolve();
  });
});
