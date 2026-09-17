import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { migrateArchivedExecutionAssignments } from "./migrations/0051-archived-execution-shape";
import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  createGraphWorkflowArchivedExecutionsRepo,
  type GraphWorkflowArchivedExecutionsRepo,
} from "./graph-workflow-archived-executions-repo";
import { createSessionsRepo } from "./sessions-repo";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { PersistenceError } from "../shared/errors";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: GraphWorkflowArchivedExecutionsRepo;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  createSessionsRepo(db).upsert(
    PROJECT_PATH,
    sessionStateSchema.parse({
      sessionName: SESSION_NAME,
      worktreePath: "/wt/s1",
      branchName: "csm/s1",
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }),
  );
  repo = createGraphWorkflowArchivedExecutionsRepo(db);
});

afterEach(() => {
  db.close();
});

/**
 * An execution blob exactly as it was archived before agent assignments
 * existed: a bare per-backend implementer config and the provider-named
 * singleton validator (or a bare `null` for "validation off").
 */
function legacyArchivedBlob(): Record<string, unknown> {
  const execution = JSON.parse(
    JSON.stringify(createWorkflowExecution({ id: "wf-legacy" })),
  ) as Record<string, unknown>;
  const workingDefinition = execution.workingDefinition as Record<
    string,
    unknown
  >;
  const contexts = workingDefinition.executionContexts as Record<
    string,
    unknown
  >[];

  contexts[0] = {
    ...contexts[0],
    // Pre-`backend` implementer shape: the field did not exist, and Claude was
    // the only backend.
    implementer: { model: "opus", reasoningEffort: "high" },
    contextValidator: {
      type: "claude",
      enabled: true,
      continuity: { enabled: true, contextLimitTokens: 120000 },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    },
  };
  contexts[1] = {
    ...contexts[1],
    implementer: {
      backend: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    },
    // Codex validators could omit model and effort entirely.
    contextValidator: {
      type: "codex",
      enabled: true,
      continuity: { enabled: false },
      codex: {},
    },
  };
  contexts[2] = {
    ...contexts[2],
    implementer: { backend: "claude", model: "sonnet", reasoningEffort: "low" },
    contextValidator: null,
  };

  return {
    ...execution,
    workingDefinition: { ...workingDefinition, executionContexts: contexts },
  };
}

function insertRawBlob(executionId: string, blob: unknown): void {
  db.prepare(
    `INSERT INTO graph_workflow_archived_executions (
       project_path, session_name, execution_id, archived_at,
       status, started_at, completed_at, execution_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    executionId,
    "2026-01-02T01:00:00Z",
    "completed",
    "2026-01-01T00:00:00Z",
    "2026-01-02T00:00:00Z",
    JSON.stringify(blob),
  );
  migrateArchivedExecutionAssignments(db);
}

function readRawBlob(executionId: string): string {
  const row = db
    .prepare(
      "SELECT execution_json FROM graph_workflow_archived_executions WHERE execution_id = ?",
    )
    .get(executionId) as { execution_json: string };
  return row.execution_json;
}

describe("archived execution one-time assignment migration", () => {
  it("decodes a pre-assignment implementer into a built-in implementer assignment", () => {
    insertRawBlob("wf-legacy", legacyArchivedBlob());

    const execution = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-legacy",
    );

    const contexts = execution?.workingDefinition.executionContexts ?? [];
    expect(contexts[0]?.implementer).toMatchObject({
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      },
    });
    expect(contexts[1]?.implementer).toMatchObject({
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
    });
  });

  it("records the absence of a profile layer rather than inventing one", () => {
    insertRawBlob("wf-legacy", legacyArchivedBlob());

    const execution = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-legacy",
    );

    const context = execution?.workingDefinition.executionContexts[0];
    const snapshots = [
      context?.implementer.profileSnapshot,
      context?.contextValidator.assignments[0]?.profileSnapshot,
    ];

    for (const snapshot of snapshots) {
      expect(snapshot).toBeDefined();
      // The placeholder says what it is; it never claims to be the built-in
      // profile's current text, which this run predates and never saw.
      expect(snapshot?.instructions).toContain(
        "ran before agent profiles existed",
      );
      expect(snapshot?.name).toContain("No profile");
      // The hashes cover the placeholder they describe, so the record stays
      // internally consistent instead of carrying a hash of something else.
      expect(snapshot?.resolvedInstructionHash).toBe(
        computeContentHash(snapshot?.renderedInstructionBlock ?? ""),
      );
      expect(snapshot?.sourceContentHash).toBe(
        computeContentHash(snapshot?.instructions ?? ""),
      );
    }
  });

  it("decodes the singleton validator into a cohort of one on both strategies", () => {
    insertRawBlob("wf-legacy", legacyArchivedBlob());

    const execution = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-legacy",
    );

    const contexts = execution?.workingDefinition.executionContexts ?? [];
    expect(contexts[0]?.contextValidator).toMatchObject({
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          strategy: "conversation",
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
          continuity: { enabled: true, contextLimitTokens: 120000 },
        },
      ],
    });
    // A Codex validator ran the task strategy; omitting model and effort meant
    // the task-run transport resolved agentBackends.codex, so the decode
    // materializes that profile — gpt-5.4 at high effort, not the UI default.
    expect(contexts[1]?.contextValidator).toMatchObject({
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          strategy: "task",
          agent: {
            backend: "codex",
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { reasoning: "high", fast: "false" },
            },
          },
          continuity: { enabled: false },
        },
      ],
    });
  });

  it("keeps a legacy Codex validator's explicitly configured model and effort", () => {
    const blob = legacyArchivedBlob();
    const contexts = (blob.workingDefinition as Record<string, unknown>)
      .executionContexts as Record<string, unknown>[];
    contexts[1] = {
      ...contexts[1],
      contextValidator: {
        type: "codex",
        enabled: true,
        continuity: { enabled: true },
        codex: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      },
    };
    insertRawBlob("wf-legacy-codex", blob);

    const execution = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-legacy-codex",
    );

    expect(
      execution?.workingDefinition.executionContexts[1]?.contextValidator
        .assignments[0]?.agent,
    ).toEqual({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { reasoning: "xhigh", fast: "false" },
      },
    });
  });

  it("decodes a null validator into a disabled, empty cohort", () => {
    insertRawBlob("wf-legacy", legacyArchivedBlob());

    const execution = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-legacy",
    );

    expect(
      execution?.workingDefinition.executionContexts[2]?.contextValidator,
    ).toEqual({ enabled: false, assignments: [] });
  });

  it("retains a legacy disabled validator's assignment as dormant configuration", () => {
    const blob = legacyArchivedBlob();
    const workingDefinition = blob.workingDefinition as Record<string, unknown>;
    const contexts = workingDefinition.executionContexts as Record<
      string,
      unknown
    >[];
    contexts[0] = {
      ...contexts[0],
      contextValidator: {
        type: "claude",
        enabled: false,
        continuity: { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
    };
    insertRawBlob("wf-legacy-off", blob);

    const execution = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-legacy-off",
    );

    const cohort =
      execution?.workingDefinition.executionContexts[0]?.contextValidator;
    expect(cohort?.enabled).toBe(false);
    expect(cohort?.assignments).toHaveLength(1);
    expect(cohort?.assignments[0]?.agent).toEqual({
      backend: "claude",
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
    });
  });

  it("does not rewrite a migrated archive on read", () => {
    const blob = legacyArchivedBlob();
    insertRawBlob("wf-legacy", blob);
    const before = readRawBlob("wf-legacy");

    repo.findByExecution(PROJECT_PATH, SESSION_NAME, "wf-legacy");

    expect(readRawBlob("wf-legacy")).toBe(before);
    expect(before).not.toContain('"type":"claude"');
  });

  it("still refuses a blob that is broken for reasons the floor does not cover", () => {
    const blob = legacyArchivedBlob();
    insertRawBlob("wf-broken", { ...blob, status: "not-a-status" });

    expect(() =>
      repo.findByExecution(PROJECT_PATH, SESSION_NAME, "wf-broken"),
    ).toThrow(PersistenceError);
  });

  describe("refuses what the former shapes themselves refused", () => {
    function withValidator(
      executionId: string,
      contextValidator: unknown,
    ): void {
      const blob = legacyArchivedBlob();
      const contexts = (blob.workingDefinition as Record<string, unknown>)
        .executionContexts as Record<string, unknown>[];
      contexts[0] = { ...contexts[0], contextValidator };
      insertRawBlob(executionId, blob);
    }

    function expectRefused(executionId: string): void {
      expect(() =>
        repo.findByExecution(PROJECT_PATH, SESSION_NAME, executionId),
      ).toThrow(PersistenceError);
    }

    it("refuses a validator whose discriminator was never a legal type", () => {
      withValidator("wf-bogus-type", {
        type: "bogus",
        enabled: true,
        continuity: { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      });

      expectRefused("wf-bogus-type");
    });

    it("refuses a Codex validator carrying a model outside the catalog", () => {
      withValidator("wf-bad-codex-model", {
        type: "codex",
        enabled: true,
        continuity: { enabled: true },
        codex: { model: "gpt-imaginary" },
      });

      expectRefused("wf-bad-codex-model");
    });

    it("refuses a Codex validator whose codex block is not an object", () => {
      withValidator("wf-bad-codex-block", {
        type: "codex",
        enabled: true,
        continuity: { enabled: true },
        codex: "gpt-5.4",
      });

      expectRefused("wf-bad-codex-block");
    });

    it("refuses a validator with a non-boolean enabled flag", () => {
      withValidator("wf-bad-enabled", {
        type: "claude",
        enabled: "yes",
        continuity: { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      });

      expectRefused("wf-bad-enabled");
    });

    it("refuses a validator with a malformed continuity policy", () => {
      withValidator("wf-bad-continuity", {
        type: "claude",
        enabled: true,
        continuity: { enabled: "sometimes" },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      });

      expectRefused("wf-bad-continuity");
    });

    it("refuses a Claude validator whose runtime pairing was never legal", () => {
      withValidator("wf-bad-pairing", {
        type: "claude",
        enabled: true,
        continuity: { enabled: true },
        agent: { backend: "claude", model: "gpt-5.4", reasoningEffort: "high" },
      });

      expectRefused("wf-bad-pairing");
    });

    it("refuses an implementer that was never a legal runtime config", () => {
      const blob = legacyArchivedBlob();
      const contexts = (blob.workingDefinition as Record<string, unknown>)
        .executionContexts as Record<string, unknown>[];
      contexts[0] = {
        ...contexts[0],
        implementer: { model: "gpt-5.4", reasoningEffort: "high" },
      };
      insertRawBlob("wf-bad-implementer", blob);

      expectRefused("wf-bad-implementer");
    });
  });

  describe("refuses shapes that belong to no single generation", () => {
    const CURRENT_IMPLEMENTER = {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      },
    };
    const CURRENT_COHORT = {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          strategy: "conversation",
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
          continuity: { enabled: true },
        },
      ],
    };

    function insertWithContexts(
      executionId: string,
      patches: Record<number, Record<string, unknown>>,
    ): void {
      const blob = legacyArchivedBlob();
      const contexts = (blob.workingDefinition as Record<string, unknown>)
        .executionContexts as Record<string, unknown>[];
      for (const [index, patch] of Object.entries(patches)) {
        contexts[Number(index)] = { ...contexts[Number(index)], ...patch };
      }
      insertRawBlob(executionId, blob);
    }

    function expectRefused(executionId: string): void {
      expect(() =>
        repo.findByExecution(PROJECT_PATH, SESSION_NAME, executionId),
      ).toThrow(PersistenceError);
    }

    it("refuses a context pairing a current implementer with a legacy disabled validator", () => {
      insertWithContexts("wf-hybrid-null", {
        0: { implementer: CURRENT_IMPLEMENTER, contextValidator: null },
      });

      expectRefused("wf-hybrid-null");
    });

    it("refuses a context pairing a current implementer with a legacy singleton validator", () => {
      insertWithContexts("wf-hybrid-singleton", {
        0: { implementer: CURRENT_IMPLEMENTER },
      });

      expectRefused("wf-hybrid-singleton");
    });

    it("refuses a context pairing a legacy implementer with a current cohort", () => {
      insertWithContexts("wf-hybrid-cohort", {
        0: { contextValidator: CURRENT_COHORT },
      });

      expectRefused("wf-hybrid-cohort");
    });

    it("refuses a blob whose contexts span both generations", () => {
      insertWithContexts("wf-mixed-contexts", {
        1: {
          implementer: CURRENT_IMPLEMENTER,
          contextValidator: CURRENT_COHORT,
        },
      });

      expectRefused("wf-mixed-contexts");
    });
  });
});

/**
 * History is a list, and one unreadable row in it is not a reason to hide the
 * rest. `findByExecution` still throws — a caller who asked for THAT execution
 * gets told it is broken — but the list skips and records a diagnostic.
 */
describe("listBySession", () => {
  it("returns every decodable archived execution, newest first", () => {
    insertRawBlob("wf-legacy", legacyArchivedBlob());
    insertRawBlob(
      "wf-current",
      JSON.parse(
        JSON.stringify(createWorkflowExecution({ id: "wf-current" })),
      ) as Record<string, unknown>,
    );

    const executions = repo.listBySession(PROJECT_PATH, SESSION_NAME);

    expect(executions.map((execution) => execution.id).sort()).toEqual([
      "wf-current",
      "wf-legacy",
    ]);
  });

  it("skips an undecodable row instead of failing the whole history", () => {
    insertRawBlob("wf-broken", { id: "wf-broken", not: "an execution" });
    insertRawBlob("wf-legacy", legacyArchivedBlob());

    const executions = repo.listBySession(PROJECT_PATH, SESSION_NAME);

    expect(executions.map((execution) => execution.id)).toEqual(["wf-legacy"]);
    // The skipped row is untouched — a broken record is not repaired on read.
    expect(JSON.parse(readRawBlob("wf-broken"))).toEqual({
      id: "wf-broken",
      not: "an execution",
    });
  });

  it("still throws when the caller asks for that one broken execution", () => {
    insertRawBlob("wf-broken", { id: "wf-broken", not: "an execution" });

    expect(() =>
      repo.findByExecution(PROJECT_PATH, SESSION_NAME, "wf-broken"),
    ).toThrow(PersistenceError);
  });
});
