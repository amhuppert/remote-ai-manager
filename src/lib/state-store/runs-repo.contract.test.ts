import { afterEach, describe, it } from "vitest";
import { contextContractSchema } from "@/lib/execution-context/schemas";
import { runBoundarySchema, runRecordSchema } from "@/lib/runs/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { createRunsRepo } from "./runs-repo";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

const seat = {
  profile: { tier: "builtin" as const, id: "general-reviewer" },
  backend: "codex" as const,
  modelSelection: { modelId: "gpt-5.4", parameters: { reasoning: "high" } },
};

const contract = contextContractSchema.parse({
  title: "Fix it",
  brief: "Fix the notice",
  tasks: [{ id: "t1", title: "Fix", instructions: "Change notice.ts" }],
  acceptanceCriteria: [{ id: "ac-1", text: "One notice" }],
  outputSchema: { type: "object" },
  allowTaskAddition: true,
  implementer: { id: "implementer", focus: "Backend", ...seat },
  reviewers: [
    { id: "reviewer-a", authority: "blocking", focus: "Correctness", ...seat },
  ],
  checks: ["typecheck"],
  humanApproval: true,
  ownerQuestions: true,
  documents: [
    {
      artifactId: "a-1",
      path: "docs/x.md",
      description: "Design",
      readWhen: "Before editing",
    },
  ],
});

describe("runs repository", () => {
  it("round-trips a run with its invocations, control and observed progress", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createRunsRepo(db);
    // Deliberately maximal: every nullable field set and every array non-empty.
    await assertRoundTripDurability({
      label: "run record",
      schema: runRecordSchema,
      buildMaximalFixture: () => ({
        runId: "run-1",
        projectPath: "/repo",
        sessionName: "session",
        ownerConversationId: "owner-1",
        ownerSessionName: "session",
        launchCause: "launch-1",
        facts: {
          runId: "run-1",
          kind: "workflow" as const,
          title: "Fix the notice",
          invocations: [
            {
              key: "implement",
              pass: 1,
              contextId: "run-1.implement.1",
              startCause: "run-1:start:implement:1",
              request: {
                contextId: "run-1.implement.1",
                runId: "run-1",
                ownerConversationId: "owner-1",
                workspace: {
                  kind: "session" as const,
                  projectPath: "/repo",
                  sessionName: "session",
                  worktreePath: "/repo/.worktrees/session",
                  scope: { mode: "owned" as const, paths: ["src/api"] },
                },
                contract,
                policy: {
                  unfinishedTaskRetries: 2,
                  validationRetries: 3,
                  captureRepairLimit: 1,
                  instabilityLimit: 3,
                  adviceCorrectionLimit: 1,
                  invocationTimeoutMs: 600000,
                },
              },
            },
          ],
          control: { paused: true, cancelled: true },
        },
        revision: 4,
        progress: {
          kind: "needs_owner" as const,
          reasons: ["implement: question"],
        },
        invocations: [
          {
            key: "implement",
            contextId: "run-1.implement.1",
            progress: {
              kind: "waiting" as const,
              obligation: { kind: "await_answer" as const, questionId: "q-1" },
            },
            occurrence: "run-1.implement.1:progress:3",
          },
        ],
        createdAt: "2026-10-03T10:00:00.000Z",
        updatedAt: "2026-10-03T10:05:00.000Z",
      }),
      persist: (value) => {
        repo.insertIfAbsent(value);
        return value;
      },
      reload: (value) => createRunsRepo(db).get(value.runId),
    });
  });

  it("round-trips a boundary with its detail and notification", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createRunsRepo(db);
    await assertRoundTripDurability({
      label: "run boundary",
      schema: runBoundarySchema,
      buildMaximalFixture: () => ({
        seq: 1,
        runId: "run-1",
        occurrence: "run-1.implement.1:progress:3",
        kind: "question" as const,
        summary: "Fix it: the agent asked you a question.",
        detail: { contextId: "run-1.implement.1", questionId: "q-1" },
        recordedAt: "2026-10-03T10:05:00.000Z",
        notifiedAt: "2026-10-03T10:05:01.000Z",
      }),
      persist: (value) => {
        repo.recordBoundary(value);
        if (value.notifiedAt !== null)
          repo.markNotified(value.seq, value.notifiedAt);
        return value;
      },
      reload: (value) =>
        createRunsRepo(db)
          .boundaries(value.runId)
          .find((b) => b.seq === value.seq) ?? null,
    });
  });
});
