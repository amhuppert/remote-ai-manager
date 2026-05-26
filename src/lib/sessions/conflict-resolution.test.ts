import { describe, it, expect, vi } from "vitest";
import {
  createConflictResolver,
  type ConflictResolutionDeps,
} from "./conflict-resolution";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";

// ============================================================
// Test helpers
// ============================================================

const PROJECT_PATH = "/projects/repo";
const SESSION_NAME = "feature-branch";
const CONVERSATION_ID = "conv-conflicts-1";

function structuredOk(structured: unknown): TaskRunResult {
  return {
    kind: "structured",
    structuredOutput: structured,
    text: "",
    usage: {
      costUsd: null,
      durationMs: null,
      contextTokens: null,
      contextWindowMax: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    },
    backendRef: null,
  };
}

function textOk(text: string): TaskRunResult {
  return {
    kind: "text",
    text,
    usage: {
      costUsd: null,
      durationMs: null,
      contextTokens: null,
      contextWindowMax: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    },
    backendRef: null,
  };
}

function errResult(error: string, aborted = false): TaskRunResult {
  return {
    kind: "error",
    error,
    aborted,
    usage: {
      costUsd: null,
      durationMs: null,
      contextTokens: null,
      contextWindowMax: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    },
    backendRef: null,
  };
}

function createTestDeps(
  overrides?: Partial<ConflictResolutionDeps>,
): ConflictResolutionDeps {
  return {
    readConfig: vi.fn().mockResolvedValue({
      baseDir: "/home/user/projects",
      ignorePatterns: [],
      claudeTimeoutMs: 60_000,
      defaultModel: "opus",
    }) as unknown as ConflictResolutionDeps["readConfig"],
    executeWorkflowTaskRun: vi.fn().mockResolvedValue(textOk("")),
    ...overrides,
  };
}

const SAMPLE_ENTRIES = [
  {
    file: "src/index.ts",
    description: "Conflicting import statements",
    resolution: "Kept both imports in correct order",
    rationale: "Both imports are needed",
  },
  {
    file: "src/utils.ts",
    description: "Different function implementations",
    resolution: "Merged both implementations",
    rationale: "Feature branch had more complete impl",
  },
];

// ============================================================
// resolveConflicts
// ============================================================

describe("resolveConflicts (executeWorkflowTaskRun)", () => {
  it("routes via executeWorkflowTaskRun with projectPath/sessionName/conversationId, kind=task_run, and the conflict JSON schema as outputFormat", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));

    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("resolved");
    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.projectPath).toBe(PROJECT_PATH);
    expect(input.sessionName).toBe(SESSION_NAME);
    expect(input.conversationId).toBe(CONVERSATION_ID);
    expect(input.kind).toBe("task_run");
    expect(typeof input.prompt).toBe("string");
    expect(input.prompt).toContain("Resolve all merge conflicts");
    expect(typeof input.systemInstructions).toBe("string");
    expect(input.outputFormat).toBeDefined();
    expect(input.outputFormat?.type).toBe("json_schema");
    expect(input.outputFormat?.schema).toMatchObject({
      type: "object",
      properties: {
        conflicts: {
          type: "array",
          items: {
            type: "object",
            required: ["file", "description", "resolution", "rationale"],
          },
        },
      },
      required: ["conflicts"],
    });
    expect(input.timeoutMs).toBe(60_000);
  });

  it("returns resolved status with conflicts when executeWorkflowTaskRun returns structured output", async () => {
    const executeWorkflowTaskRun = vi
      .fn()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.conflicts).toHaveLength(2);
      expect(result.conflicts[0]!.file).toBe("src/index.ts");
      expect(result.conflicts[1]!.file).toBe("src/utils.ts");
    }
  });

  it("falls back to fenced-JSON text parse when structuredOutput is absent (text kind)", async () => {
    const text = `Here is the analysis:

\`\`\`json
${JSON.stringify({ conflicts: SAMPLE_ENTRIES }, null, 2)}
\`\`\``;
    const executeWorkflowTaskRun = vi.fn().mockResolvedValue(textOk(text));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.conflicts).toHaveLength(2);
    }
  });

  it("returns failed status when executeWorkflowTaskRun returns kind=error", async () => {
    const executeWorkflowTaskRun = vi
      .fn()
      .mockResolvedValue(errResult("backend exploded"));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("backend exploded");
    }
  });

  it("returns failed status when structured output does not match the schema", async () => {
    const executeWorkflowTaskRun = vi
      .fn()
      .mockResolvedValue(structuredOk({ conflicts: [{ file: "x" }] }));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("failed");
  });

  it("includes per-file decisions in the prompt when provided", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);

    const decisions = [
      { file: "src/index.ts", decision: "approved" as const },
      {
        file: "src/utils.ts",
        decision: "rejected" as const,
        feedback: "Use the feature branch version",
      },
      { file: "src/config.ts", decision: "pending" as const },
    ];

    await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      decisions,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("APPROVED");
    expect(input.prompt).toContain("REJECTED");
    expect(input.prompt).toContain("PENDING");
    expect(input.prompt).toContain("Use the feature branch version");
  });
});

// ============================================================
// analyzeConflicts
// ============================================================

describe("analyzeConflicts (executeWorkflowTaskRun)", () => {
  it("uses analysis-only system instructions (no edit/stage directives)", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { analyzeConflicts } = createConflictResolver(deps);

    await analyzeConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    const instructions = input.systemInstructions ?? "";
    expect(instructions).toContain("DO NOT");
    expect(instructions).not.toContain("Edit each file");
    expect(instructions).not.toContain("Stage each resolved file");
  });

  it("returns analyzed status with conflicts on success", async () => {
    const executeWorkflowTaskRun = vi
      .fn()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { analyzeConflicts } = createConflictResolver(deps);

    const result = await analyzeConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("analyzed");
    if (result.status === "analyzed") {
      expect(result.conflicts).toHaveLength(2);
    }
  });

  it("returns failed status on backend error", async () => {
    const executeWorkflowTaskRun = vi
      .fn()
      .mockResolvedValue(errResult("SDK down"));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { analyzeConflicts } = createConflictResolver(deps);

    const result = await analyzeConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("SDK down");
    }
  });
});

// ============================================================
// Parity: same structured input produces the same parsed conflicts
// regardless of whether the runner returned them via structuredOutput
// or as fenced JSON in text. The structured-output contract must survive
// the migration to executeWorkflowTaskRun.
// ============================================================

describe("conflict-resolution structured-output parity", () => {
  it("produces identical resolved conflicts whether routed via structuredOutput or fenced-JSON text", async () => {
    const fixture = { conflicts: SAMPLE_ENTRIES };

    const structuredRunner = vi.fn().mockResolvedValue(structuredOk(fixture));
    const structuredDeps = createTestDeps({
      executeWorkflowTaskRun: structuredRunner,
    });
    const { resolveConflicts: resolveStructured } =
      createConflictResolver(structuredDeps);
    const structuredResult = await resolveStructured({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    const text = `\`\`\`json\n${JSON.stringify(fixture, null, 2)}\n\`\`\``;
    const textRunner = vi.fn().mockResolvedValue(textOk(text));
    const textDeps = createTestDeps({ executeWorkflowTaskRun: textRunner });
    const { resolveConflicts: resolveText } = createConflictResolver(textDeps);
    const textResult = await resolveText({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(structuredResult).toEqual(textResult);
    expect(structuredResult.status).toBe("resolved");
    if (structuredResult.status === "resolved") {
      expect(structuredResult.conflicts).toEqual(SAMPLE_ENTRIES);
    }
  });
});
