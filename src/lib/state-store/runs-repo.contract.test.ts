import { afterEach, describe, expect, it } from "vitest";
import { contextContractSchema } from "@/lib/execution-context/schemas";
import {
  runBoundarySchema,
  runRecordSchema,
  type RunCharterRevision,
} from "@/lib/runs/schemas";
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
  deferredChecks: ["test"],
  inputs: [
    { key: "api", title: "Build the API", output: { endpoint: "/v1/x" } },
  ],
  humanApproval: true,
  ownerQuestions: true,
  documentPublishing: true,
  documents: [
    {
      artifactId: "a-1",
      path: "docs/x.md",
      description: "Design",
      readWhen: "Before editing",
    },
  ],
  charter: {
    revision: 1,
    mission: "Fix the notice",
    conventions: ["Name events with dots"],
    nonGoals: ["Networked filesystems"],
    vocabulary: ["notice"],
    testStrategy: "Behaviour tests",
    knownAmbiguities: ["Retries"],
    invariants: [{ id: "no-mocks", statement: "No internal mocks" }],
    sourcesOfTruth: [
      {
        rank: 1,
        id: "spec",
        label: "Spec",
        type: "spec",
        locator: "specs/notice.md",
        description: "The spec",
      },
    ],
    documentPath: ".cc/run-docs/run-1.implement.1/charter.md",
  },
});

function request(contextId: string) {
  return {
    contextId,
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
  };
}

/** An amended charter and its removal, every optional field set (the first revision is the one checked in full). */
const charterRevisions: RunCharterRevision[] = [
  {
    revision: 2,
    source: "amend",
    at: "2026-10-07T10:00:00.000Z",
    reason: "Retries are out of scope",
    charter: {
      mission: "Fix the notice",
      conventions: ["Name events with dots"],
      nonGoals: ["Networked filesystems"],
      vocabulary: ["notice"],
      testStrategy: "Behaviour tests",
      knownAmbiguities: ["Retries"],
      invariants: [
        {
          id: "no-mocks",
          statement: "No internal mocks",
          appliesTo: ["implement"],
        },
      ],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "spec",
          label: "Spec",
          type: "spec",
          locator: "specs/notice.md",
          description: "The spec",
          appliesTo: ["implement"],
        },
      ],
    },
    bundles: {
      default: `sha256:${"a".repeat(64)}`,
      byKey: { implement: `sha256:${"b".repeat(64)}` },
    },
  },
  {
    revision: 3,
    source: "amend",
    at: "2026-10-07T11:00:00.000Z",
    reason: "The notice work moved to its own run",
    charter: null,
    bundles: null,
  },
];

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
          definition: {
            revision: 2,
            contexts: [
              {
                key: "implement",
                dependsOn: ["plan", "review"],
                when: {
                  plan: {
                    schema: {
                      type: "object",
                      properties: { go: { const: true } },
                    },
                  },
                  review: { else: true as const },
                },
                routing: { cardinality: "exactlyOne" as const },
                outputOnly: ["review"],
                lane: "api",
                request: request("run-1.implement.1"),
              },
            ],
            lanes: [
              {
                key: "api",
                laneId: "1-api",
                worktreePath: "/repo/.worktrees/session.1-api",
                branch: "csm/session-1-api",
                target: {
                  worktreePath: "/repo/.worktrees/session",
                  branch: "csm/session",
                },
                checks: ["typecheck"],
              },
            ],
            loops: [
              {
                key: "polish",
                body: ["implement"],
                entry: "implement",
                exit: "implement",
                until: {
                  schema: {
                    type: "object",
                    properties: { done: { const: true } },
                  },
                },
                maxPasses: 3,
              },
            ],
            authored: {
              title: "Fix the notice",
              contexts: [{ key: "implement", brief: "Fix it", lane: "api" }],
            },
          },
          documents: [
            // Every optional field set, though a published revision has no reason and an amended one no publisher.
            {
              path: "notes/plan.md",
              revision: 1,
              source: "publish" as const,
              at: "2026-10-07T10:00:00.000Z",
              by: "run-1.implement.1",
              reason: "The plan changed",
              document: {
                artifactId: `sha256:${"a".repeat(64)}`,
                bytes: 7,
                description: "The plan",
                readWhen: "Before you start",
                appliesTo: ["implement"],
              },
            },
            {
              path: "notes/plan.md",
              revision: 2,
              source: "amend" as const,
              at: "2026-10-07T11:00:00.000Z",
              document: null,
            },
          ],
          charter: charterRevisions,
          invocations: [
            {
              key: "implement",
              pass: 1,
              contextId: "run-1.implement.1",
              startCause: "run-1:start:implement:1",
              froze: {
                charter: 2,
                documents: [{ path: "notes/plan.md", revision: 1 }],
              },
            },
          ],
          lanes: {
            api: {
              provision: {
                attempt: 2,
                outcome: { kind: "provisioned" as const, baseline: "b0" },
              },
              publication: {
                attempt: 3,
                outcome: {
                  kind: "published" as const,
                  commit: "p3",
                  incorporated: "h2",
                },
              },
            },
          },
          control: {
            paused: true,
            cancelled: true,
            fault: {
              detail: "The definition could not be read",
              at: "2026-10-03T10:04:00.000Z",
            },
          },
          acts: [
            {
              action: "resume" as const,
              by: "person" as const,
              at: "2026-10-03T10:03:00.000Z",
              dispositions: [
                { contextId: "run-1.implement", disposition: "continue" },
              ],
            },
            {
              action: "retry_lane" as const,
              by: "owner" as const,
              at: "2026-10-03T10:03:30.000Z",
              lane: "api",
            },
          ],
          amendments: [
            {
              revision: 2,
              at: "2026-10-03T10:02:30.000Z",
              reason: "Ship only what triage approved",
            },
          ],
        },
        revision: 4,
        progress: {
          kind: "needs_owner" as const,
          reasons: ["implement: question"],
        },
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

  it("lists a session's runs, newest first", () => {
    fixture = createPersistenceFixture();
    const repo = createRunsRepo(fixture.db);
    const run = (runId: string, sessionName: string, createdAt: string) =>
      runRecordSchema.parse({
        runId,
        projectPath: "/repo",
        sessionName,
        ownerConversationId: "owner-1",
        ownerSessionName: sessionName,
        launchCause: `launch-${runId}`,
        facts: {
          runId,
          kind: "agent",
          title: runId,
          definition: {
            revision: 1,
            contexts: [
              {
                key: "agent",
                dependsOn: [],
                request: request(`${runId}.agent`),
              },
            ],
          },
          invocations: [],
          control: { paused: false, cancelled: false },
        },
        revision: 1,
        progress: { kind: "running" },
        createdAt,
        updatedAt: createdAt,
      });
    repo.insertIfAbsent(run("run-a", "session", "2026-10-03T10:00:00.000Z"));
    repo.insertIfAbsent(run("run-b", "other", "2026-10-03T10:01:00.000Z"));
    repo.insertIfAbsent(run("run-c", "session", "2026-10-03T10:02:00.000Z"));

    expect(
      repo.listBySession("/repo", "session").map((r) => r.runId),
    ).toEqual(["run-c", "run-a"]);
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
        detail: {
          kind: "question" as const,
          contextId: "run-1.implement.1",
          questionId: "q-1",
        },
        recordedAt: "2026-10-03T10:05:00.000Z",
      }),
      persist: (value) => {
        repo.recordBoundary(value);
        return value;
      },
      reload: (value) =>
        createRunsRepo(db)
          .boundaries(value.runId)
          .find((b) => b.seq === value.seq) ?? null,
    });
  });

  it.each([
    {
      kind: "halted" as const,
      detail: {
        kind: "run_halt" as const,
        halt: "lane_publication" as const,
        clearedBy: "retry_lane" as const,
        lane: "api",
        otherWorkRemains: true,
      },
    },
    {
      kind: "succeeded" as const,
      detail: {
        kind: "succeeded" as const,
        outputs: { api: { summary: "Built." }, docs: null },
      },
    },
  ])(
    "round-trips a $detail.kind boundary's detail, with its optional and open fields",
    async ({ kind, detail }) => {
      fixture = createPersistenceFixture();
      const db = fixture.db;
      const repo = createRunsRepo(db);
      await assertRoundTripDurability({
        label: `run boundary (${detail.kind})`,
        schema: runBoundarySchema,
        buildMaximalFixture: () => ({
          seq: 1,
          runId: "run-1",
          occurrence: `run-1:${detail.kind}`,
          kind,
          summary: "Fix it: something happened.",
          detail,
          recordedAt: "2026-10-03T10:05:00.000Z",
        }),
        persist: (value) => {
          repo.recordBoundary(value);
          return value;
        },
        reload: (value) =>
          createRunsRepo(db)
            .boundaries(value.runId)
            .find((b) => b.seq === value.seq) ?? null,
      });
    },
  );
});
