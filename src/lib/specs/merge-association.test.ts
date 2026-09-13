import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerInfo = vi.hoisted(() => vi.fn());

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: loggerInfo,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
import type { SpecExecutionRow } from "./schemas";
import { specExecutionRowSchema } from "./schemas";
import {
  createMergeAssociationResolver,
  type MergeAssociationResolverDeps,
} from "./merge-association";

const PROJECT_PATH = "/repos/assoc-project";
const SESSION = "fx-host";

beforeEach(() => {
  loggerInfo.mockClear();
});

function executionRow(overrides: Partial<SpecExecutionRow>): SpecExecutionRow {
  return specExecutionRowSchema.parse({
    id: "spec-exec-1",
    spec_id: "spec-1",
    revision_id: "rev-1",
    scope_json: JSON.stringify({ criterionElementIds: ["crit-1"] }),
    state: "running",
    execution_start_dial: "gate",
    workflow_definition_id: "wf-def-1",
    workflow_definition_revision: 1,
    workflow_execution_id: "wf-exec-1",
    session_name: SESSION,
    delivered_at: null,
    abandoned_reason: null,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: "2026-07-19T10:00:00.000Z",
    updated_at: "2026-07-19T10:01:00.000Z",
    ...overrides,
  });
}

function expectedLogBasis(executions: SpecExecutionRow[]) {
  return {
    activeExecutionCount: executions.length,
    activeExecutions: executions.map((execution) => ({
      specExecutionId: execution.id,
      state: execution.state,
      workflowExecutionId: execution.workflow_execution_id,
    })),
  };
}

function makeDeps(
  executions: SpecExecutionRow[],
  targetBranch: string | null = "main",
): MergeAssociationResolverDeps {
  return {
    findActiveExecutionsBySessionName(projectPath, sessionName) {
      if (projectPath !== PROJECT_PATH || sessionName !== SESSION) return [];
      return executions;
    },
    getSessionTargetBranch() {
      return targetBranch;
    },
  };
}

function resolve(deps: MergeAssociationResolverDeps, targetBranch?: string) {
  return createMergeAssociationResolver(deps).resolve({
    projectPath: PROJECT_PATH,
    projectName: "assoc-project",
    sessionName: SESSION,
    ...(targetBranch !== undefined && { targetBranch }),
  });
}

describe("merge association resolver", () => {
  it("links session delivery by its spec execution without inventing a workflow", () => {
    expect(
      resolve(
        makeDeps([
          executionRow({
            workflow_execution_id: null,
            delivery_basis_json: JSON.stringify({
              kind: "session",
              sourceSpecExecutionIds: [],
              sourceWorkflowExecutionIds: [],
              commitRefs: [],
              note: "",
              actor: { kind: "human" },
              createdAt: "2026-09-12T12:00:00Z",
            }),
          }),
        ]),
      ),
    ).toEqual({
      kind: "linked",
      specExecutionId: "spec-exec-1",
      finalPublish: true,
    });
  });
  it("passes through when the session hosts no active execution", () => {
    expect(resolve(makeDeps([]))).toEqual({ kind: "none" });
  });

  it("links a running execution and marks the default-target merge as final publish", () => {
    const result = resolve(makeDeps([executionRow({})]));
    expect(result).toEqual({
      kind: "linked",
      executionId: "wf-exec-1",
      finalPublish: true,
    });
  });

  it("marks an explicit delivery-target merge as final publish", () => {
    const result = resolve(makeDeps([executionRow({})], "main"), "main");
    expect(result).toEqual({
      kind: "linked",
      executionId: "wf-exec-1",
      finalPublish: true,
    });
  });

  it("links but does not final-publish a merge to a non-delivery target", () => {
    const result = resolve(
      makeDeps([executionRow({})], "main"),
      "csm/some-other-session",
    );
    expect(result).toEqual({
      kind: "linked",
      executionId: "wf-exec-1",
      finalPublish: false,
    });
  });

  it("refuses at dispatch when the hosted execution has not started", () => {
    const result = resolve(
      makeDeps([
        executionRow({
          state: "definition_review",
          workflow_execution_id: null,
        }),
      ]),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("expected refusal");
    expect(result.reason).toContain("spec-exec-1");
    expect(result.reason).toContain("definition review");
    expect(result.instruction).toMatch(/start|abandon/i);
  });

  it("refuses a running execution with no linked workflow execution", () => {
    const result = resolve(
      makeDeps([executionRow({ workflow_execution_id: null })]),
    );
    expect(result.kind).toBe("refused");
  });

  it("refuses when association is ambiguous across multiple active executions", () => {
    const result = resolve(
      makeDeps([
        executionRow({}),
        executionRow({
          id: "spec-exec-2",
          spec_id: "spec-2",
          workflow_execution_id: "wf-exec-2",
        }),
      ]),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("expected refusal");
    expect(result.reason).toContain("spec-exec-1");
    expect(result.reason).toContain("spec-exec-2");
  });

  it("logs distinct MA8 outcomes with the durable candidate state as its basis", () => {
    const none: SpecExecutionRow[] = [];
    const running = [executionRow({})];
    const notStarted = [
      executionRow({
        state: "definition_review",
        workflow_execution_id: null,
      }),
    ];
    const ambiguous = [
      executionRow({}),
      executionRow({
        id: "spec-exec-2",
        spec_id: "spec-2",
        workflow_execution_id: "wf-exec-2",
      }),
    ];

    for (const executions of [none, running, notStarted, ambiguous]) {
      resolve(makeDeps(executions));
    }

    expect(
      loggerInfo.mock.calls.map(([message, payload]) => ({
        message,
        outcome: payload.outcome,
        basis: payload.basis,
      })),
    ).toEqual([
      {
        message: "merge.association",
        outcome: "none",
        basis: expectedLogBasis(none),
      },
      {
        message: "merge.association",
        outcome: "linked",
        basis: expectedLogBasis(running),
      },
      {
        message: "merge.association",
        outcome: "refused_not_started",
        basis: expectedLogBasis(notStarted),
      },
      {
        message: "merge.association",
        outcome: "refused_ambiguous",
        basis: expectedLogBasis(ambiguous),
      },
    ]);
  });
});
