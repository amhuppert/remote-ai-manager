import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SeatTurnResult } from "@/lib/conversation-core/executor";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { RunSupervision } from "./supervision";
import {
  agentStartRequest,
  createSupervisionHarness,
  done,
  quiesce,
} from "./testing/supervision-fixture";

let fixture: PersistenceFixture;
let h: ReturnType<typeof createSupervisionHarness>;

async function launch(
  s: RunSupervision,
  runId: string,
  turnsSettle = true,
): Promise<void> {
  await s.runs.launch({
    runId,
    cause: `launch-${runId}`,
    kind: "agent",
    title: "Fix the notice",
    projectPath: "/repo",
    sessionName: "session",
    owner: { conversationId: "owner-1", sessionName: "session" },
    invocations: [{ key: "agent", request: agentStartRequest(runId) }],
  });
  await quiesce(s, turnsSettle);
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  h = createSupervisionHarness(fixture);
});
afterEach(() => fixture.close());

describe("run supervision", () => {
  it("runs one agent end to end, gives the worktree back, and lets the next run bind it", async () => {
    const s = h.compose();
    await launch(s, "run-1");

    expect(s.runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(h.notified.map((b) => [b.runId, b.kind, b.detail])).toEqual([
      ["run-1", "succeeded", { outputs: { agent: { summary: "Done." } } }],
    ]);

    await launch(s, "run-2");
    expect(s.runs.observe("run-2")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(h.turnMessages).toHaveLength(2);
  });

  it("carries a seat's question to the owner and the answer back into the seat", async () => {
    const seen: unknown[] = [];
    h.script = async (input, self) => {
      if (h.turnMessages.length > 1) return done("Used notice.ts");
      seen.push(self.seatFor(input.conversationId));
      self.requests.open({
        conversationId: input.conversationId,
        attemptId: input.attemptId,
        questionText: "Which file holds the notice?",
        questions: [{ question: "Which file holds the notice?" }],
      });
      return done("Waiting for an answer.");
    };
    const s = h.compose();
    await launch(s, "run-1");

    expect(seen).toEqual([
      { canAsk: true, attemptId: expect.any(String), openQuestionId: null },
    ]);
    expect(s.seatFor("owner-1")).toBeNull();
    const question = h.notified.find((b) => b.kind === "question");
    expect(s.runs.observe("run-1")?.record.progress.kind).toBe("needs_owner");
    const questionId = (question?.detail as { questionId: string }).questionId;
    expect(s.requests.answer(questionId, "notice.ts")).toBe(true);
    await quiesce(s);

    expect(h.turnMessages[1]).toContain("notice.ts");
    expect(s.runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
  });

  it("restores a run interrupted by a restart paused, with the interrupted turn visible as a halt", async () => {
    h.script = () => new Promise<SeatTurnResult>(() => {});
    const before = h.compose();
    await launch(before, "run-1", false);
    expect(h.turnMessages).toHaveLength(1);
    expect(before.runs.observe("run-1")?.record.progress).toEqual({
      kind: "running",
    });

    const after = h.compose();
    const booted = await after.boot();
    await quiesce(after);

    expect(booted.restoredRuns).toBe(1);
    expect(after.runs.observe("run-1")?.record.progress.kind).toBe("paused");
    expect(
      after.contexts.observe("run-1.agent")?.record.progress,
    ).toMatchObject({ kind: "halted", halt: "interrupted" });
    expect(h.notified.map((b) => b.kind)).toContain("restored_paused");
  });
});
