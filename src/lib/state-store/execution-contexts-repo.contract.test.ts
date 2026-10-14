import { afterEach, describe, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  contextContractSchema,
  contextFactsSchema,
  contextRecordSchema,
} from "@/lib/execution-context/schemas";
import { createExecutionContextsRepo } from "./execution-contexts-repo";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

const seat = {
  profile: { tier: "builtin" as const, id: "general-reviewer" },
  backend: "codex" as const,
  modelSelection: { modelId: "gpt-5.4", parameters: { reasoning: "high" } },
};

describe("execution contexts repository", () => {
  it("round-trips a context record with facts, placement and progress", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createExecutionContextsRepo(db);
    const contract = contextContractSchema.parse({
      title: "Fix it",
      brief: "Fix the notice",
      tasks: [{ id: "t1", title: "Fix", instructions: "Change notice.ts" }],
      acceptanceCriteria: [{ id: "ac-1", text: "One notice" }],
      outputSchema: { type: "object" },
      allowTaskAddition: true,
      implementer: {
        id: "implementer",
        focus: "Backend",
        ...seat,
        validationAccess: ["typecheck", "test"],
      },
      reviewers: [
        {
          id: "reviewer-a",
          authority: "blocking",
          focus: "Correctness",
          ...seat,
          validationAccess: ["typecheck"],
        },
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
        mission: "Make the failure notice appear once.",
        conventions: ["Name events with dots"],
        nonGoals: ["Networked filesystems"],
        vocabulary: ["notice: the failure message"],
        testStrategy: "Behaviour tests on SQLite",
        knownAmbiguities: ["Whether retries count"],
        invariants: [
          { id: "no-mocks", statement: "No vi.mock of internal modules" },
        ],
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
        documentPath: ".cc/run-docs/ctx-1/charter.md",
      },
    });
    // Deliberately maximal: every optional field set and every array non-empty.
    const facts = contextFactsSchema.parse({
      contextId: "ctx-1",
      binding: {
        request: {
          kind: "session",
          projectPath: "/repo",
          sessionName: "session",
          worktreePath: "/repo/.worktrees/session",
          scope: { mode: "owned", paths: ["src/api"] },
        },
        bound: true,
        released: true,
      },
      contract: {
        revision: 2,
        current: contract,
        amendments: [
          {
            revision: 2,
            reason: "Clarified scope",
            at: "2026-10-03T10:30:00.000Z",
          },
        ],
      },
      policy: {
        unfinishedTaskRetries: 2,
        validationRetries: 3,
        captureRepairLimit: 1,
        instabilityLimit: 3,
        adviceCorrectionLimit: 1,
        invocationTimeoutMs: 600000,
      },
      seats: {
        conversations: { implementer: "conv-impl" },
        replacements: { implementer: 1 },
      },
      ledger: {
        revision: 2,
        tasks: [
          {
            id: "t1",
            title: "Fix",
            instructions: "Change notice.ts",
            source: "contract",
            status: "done",
          },
        ],
        settledWorkTurns: 2,
        lastSummary: "Changed notice.ts",
      },
      candidates: {
        sequence: 2,
        items: [
          {
            id: "ctx-1:candidate:2",
            contractRevision: 2,
            taskRevision: 2,
            output: { notices: 1 },
            evidence: "tree:abc",
            provenance: { kind: "advice_response", roundId: "ctx-1:round:1" },
          },
        ],
        retired: [{ candidateId: "ctx-1:candidate:1", reason: "advised" }],
        captured: { output: { notices: 1 }, workTurn: 2 },
        captureFailures: { workTurn: 1, count: 1, lastIssue: "missing field" },
        unstableCount: 1,
        verifyPending: { roundId: "ctx-1:round:1" },
        nextProvenance: { kind: "advice_response", roundId: "ctx-1:round:1" },
      },
      certification: {
        sequence: 1,
        rounds: [
          {
            id: "ctx-1:round:1",
            candidateId: "ctx-1:candidate:1",
            kind: "full",
            checks: [
              { command: "typecheck", status: "passed", detail: "clean" },
            ],
            seats: [
              {
                assignmentId: "reviewer-a",
                authority: "blocking",
                status: "pass",
                findings: [
                  { title: "Nit", description: "Fine", criterionId: "ac-1" },
                ],
                advisories: [
                  {
                    title: "Rename",
                    description: "Clearer",
                    criterionId: "ac-1",
                  },
                ],
                detail: "reviewed",
              },
            ],
            retired: true,
            openedAt: "2026-10-03T10:02:00.000Z",
          },
        ],
      },
      advice: {
        dispositions: {
          "ctx-1:round:1:reviewer-a:1": {
            disposition: "declined",
            reason: "Out of scope",
          },
        },
        correctionFailures: 1,
      },
      approval: {
        decisions: [
          {
            candidateId: "ctx-1:candidate:1",
            contractRevision: 1,
            decision: "rejected",
            notes: "Use the helper",
            decidedAt: "2026-10-03T10:40:00.000Z",
          },
        ],
        reworked: ["ctx-1:candidate:1"],
      },
      acceptance: {
        receipts: [
          {
            candidateId: "ctx-1:candidate:1",
            receipt: "snapshot:tree:abc",
            at: "2026-10-03T10:06:00.000Z",
          },
        ],
      },
      allowances: {
        granted: { unfinishedTaskRetries: 1, validationRetries: 2 },
        charges: [
          {
            cause: "ctx-1:work:2",
            kind: "unfinishedTaskRetries",
            state: "charged",
          },
        ],
      },
      control: {
        paused: true,
        cancelled: true,
        halt: {
          kind: "turn_failed",
          detail: "provider error",
          seat: "implementer",
          effect: "work" as const,
        },
        dispositions: [
          {
            occurrence: "halted:effect_uncertain:3",
            halt: "effect_uncertain",
            disposition: {
              kind: "confirm_effect",
              evidence: "The lane holds the landing",
            },
            at: "2026-10-05T12:00:00.000Z",
          },
        ],
        steers: [
          { id: "steer-1", instruction: "Use notice.ts", consumed: true },
        ],
      },
      requests: {
        open: [{ questionId: "q-2", seat: "reviewer-a" }],
        answered: [
          {
            questionId: "q-1",
            seat: "implementer",
            question: "Which file?",
            answer: "notice.ts",
            continued: true,
          },
        ],
      },
      effectSequence: 7,
    });

    await assertRoundTripDurability({
      label: "execution context",
      schema: contextRecordSchema,
      buildMaximalFixture: () => ({
        contextId: "ctx-1",
        runId: "run-1",
        projectPath: "/repo",
        sessionName: "session",
        ownerConversationId: "owner-1",
        startCause: "run-1:start:api:0",
        workspace: {
          kind: "session" as const,
          projectPath: "/repo",
          sessionName: "session",
          worktreePath: "/repo/.worktrees/session",
          scope: { mode: "owned" as const, paths: ["src/api"] },
        },
        facts,
        revision: 3,
        progress: {
          kind: "paused" as const,
          next: {
            kind: "running" as const,
            obligation: { kind: "work" as const, reason: "initial" as const },
          },
          draining: false,
        },
        progressOccurrence: "occ-2",
        createdAt: "2026-10-03T10:00:00.000Z",
        updatedAt: "2026-10-03T11:00:00.000Z",
      }),
      persist: (value) => {
        repo.insertIfAbsent(value);
        return value;
      },
      reload: (value) => createExecutionContextsRepo(db).get(value.contextId),
    });
  });
});
