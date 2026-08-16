import { describe, it, expect, vi } from "vitest";
import {
  createConflictResolver,
  parseConflictEntries,
  DEFAULT_RESOLUTION_TIMEOUT_MS,
  type ConflictResolutionDeps,
} from "./conflict-resolution";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { AgentFailureClassification } from "@/lib/agent-backends/errors";

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
    continuationDisposition: "retain",
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
    continuationDisposition: "retain",
  };
}

function errResult(
  error: string,
  aborted = false,
  failure?: AgentFailureClassification,
): TaskRunResult {
  return {
    kind: "error",
    error,
    aborted,
    ...(failure !== undefined ? { failure } : {}),
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
    continuationDisposition: "retain",
  };
}

function createTestDeps(
  overrides?: Partial<ConflictResolutionDeps>,
): ConflictResolutionDeps {
  return {
    executeWorkflowTaskRun: vi.fn().mockResolvedValue(textOk("")),
    listUnmergedFiles: async () => [],
    listTrackedMarkerFiles: async () => [],
    readWorktreeFile: async () => null,
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
    expect(input.timeoutMs).toBe(DEFAULT_RESOLUTION_TIMEOUT_MS);
  });

  it("pins the agent turn to the merge worktree (worktreePath forwarded to executeWorkflowTaskRun)", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));

    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);

    await resolveConflicts({
      worktreePath: "/projects/repo/.worktrees/lane-feature",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.worktreePath).toBe("/projects/repo/.worktrees/lane-feature");
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

  it("returns an infrastructure outcome when executeWorkflowTaskRun returns kind=error", async () => {
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

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure.message).toContain("backend exploded");
    }
  });

  it("returns an infrastructure outcome when structured output does not match the schema", async () => {
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

    expect(result.status).toBe("infrastructure");
  });

  it("includes the resolution context section in the prompt when provided", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);

    await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      resolutionContext:
        "Renamed SessionStore to SessionRepo across the codebase; keep the new name everywhere.",
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Context about the changes being merged");
    expect(input.prompt).toContain(
      "Renamed SessionStore to SessionRepo across the codebase",
    );
  });

  it("omits the resolution context section when not provided", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);

    await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).not.toContain(
      "Context about the changes being merged",
    );
  });

  it("appends the incoming-changes section to the prompt when targetBranch is provided", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const buildIncomingChangesSection = vi
      .fn()
      .mockResolvedValue(
        "Incoming commits from `main`:\n- aaaa111 Merge csm/other into main\n  Intent: reworked config loader",
      );
    const deps = createTestDeps({
      executeWorkflowTaskRun,
      buildIncomingChangesSection,
    });
    const { resolveConflicts } = createConflictResolver(deps);

    await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      targetBranch: "main",
    });

    expect(buildIncomingChangesSection).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      worktreePath: "/tmp/worktree",
      targetBranch: "main",
    });
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Incoming commits from `main`");
    expect(input.prompt).toContain("reworked config loader");
  });

  it("leaves the prompt untouched when the incoming-changes section is null", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const buildIncomingChangesSection = vi.fn().mockResolvedValue(null);
    const deps = createTestDeps({
      executeWorkflowTaskRun,
      buildIncomingChangesSection,
    });
    const { resolveConflicts } = createConflictResolver(deps);

    await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      targetBranch: "main",
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).not.toContain("Incoming commits");
  });

  it("skips the incoming-changes lookup when no targetBranch is provided", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const buildIncomingChangesSection = vi.fn().mockResolvedValue("section");
    const deps = createTestDeps({
      executeWorkflowTaskRun,
      buildIncomingChangesSection,
    });
    const { resolveConflicts } = createConflictResolver(deps);

    await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(buildIncomingChangesSection).not.toHaveBeenCalled();
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

describe("resolver prompt hardening", () => {
  it("forbids the resolver from initiating merges and requires an empty result when nothing is conflicted", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: [] }));

    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { resolveConflicts } = createConflictResolver(deps);
    await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.systemInstructions).toContain("NEVER initiate a merge");
    expect(input.systemInstructions).toContain("empty conflicts array");
    expect(input.systemInstructions).toContain("current working directory");
  });

  it("forbids the analyzer from mutating the worktree or running merges", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: [] }));

    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { analyzeConflicts } = createConflictResolver(deps);
    await analyzeConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.systemInstructions).toContain("NEVER run git merge");
    expect(input.systemInstructions).toContain("empty conflicts array");
  });
});

// ============================================================
// Turn bound: an unbounded resolver turn holds the merge (and the session's
// git lock) open indefinitely.
// ============================================================

describe("resolver turn timeout", () => {
  async function captureTurnInput(
    call: (
      run: (input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>,
    ) => Promise<unknown>,
  ): Promise<ExecuteWorkflowTaskRunInput> {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: [] }));
    await call(executeWorkflowTaskRun);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    return input;
  }

  it("bounds the resolution turn with the default timeout", async () => {
    const input = await captureTurnInput((executeWorkflowTaskRun) =>
      createConflictResolver(
        createTestDeps({ executeWorkflowTaskRun }),
      ).resolveConflicts({
        worktreePath: "/tmp/worktree",
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
      }),
    );

    expect(input.timeoutMs).toBe(900_000);
  });

  it("bounds the analysis turn with the default timeout", async () => {
    const input = await captureTurnInput((executeWorkflowTaskRun) =>
      createConflictResolver(
        createTestDeps({ executeWorkflowTaskRun }),
      ).analyzeConflicts({
        worktreePath: "/tmp/worktree",
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
      }),
    );

    expect(input.timeoutMs).toBe(900_000);
  });

  it("honors an explicit per-run timeout override", async () => {
    const input = await captureTurnInput((executeWorkflowTaskRun) =>
      createConflictResolver(
        createTestDeps({ executeWorkflowTaskRun }),
      ).resolveConflicts({
        worktreePath: "/tmp/worktree",
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        resolutionTimeoutMs: 60_000,
      }),
    );

    expect(input.timeoutMs).toBe(60_000);
  });

  it("honors an explicit per-run timeout override on the analysis turn", async () => {
    const input = await captureTurnInput((executeWorkflowTaskRun) =>
      createConflictResolver(
        createTestDeps({ executeWorkflowTaskRun }),
      ).analyzeConflicts({
        worktreePath: "/tmp/worktree",
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        resolutionTimeoutMs: 60_000,
      }),
    );

    expect(input.timeoutMs).toBe(60_000);
  });

  it("hands the caller's cancellation to the resolution turn", async () => {
    const controller = new AbortController();
    const input = await captureTurnInput((executeWorkflowTaskRun) =>
      createConflictResolver(
        createTestDeps({ executeWorkflowTaskRun }),
      ).resolveConflicts({
        worktreePath: "/tmp/worktree",
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        signal: controller.signal,
      }),
    );

    expect(input.signal).toBe(controller.signal);
  });

  it("hands the caller's cancellation to the analysis turn", async () => {
    const controller = new AbortController();
    const input = await captureTurnInput((executeWorkflowTaskRun) =>
      createConflictResolver(
        createTestDeps({ executeWorkflowTaskRun }),
      ).analyzeConflicts({
        worktreePath: "/tmp/worktree",
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        signal: controller.signal,
      }),
    );

    expect(input.signal).toBe(controller.signal);
  });
});

// ============================================================
// Outcome classification: "the resolver ran and the conflict is still
// unresolved" must be distinguishable from "the resolver never ran".
// ============================================================

describe("resolveConflicts outcome classification", () => {
  async function resolveWith(result: TaskRunResult | Error) {
    const executeWorkflowTaskRun = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const { resolveConflicts } = createConflictResolver(
      createTestDeps({ executeWorkflowTaskRun }),
    );
    return resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
  }

  it("carries the backend's classification when the turn failed with one", async () => {
    const failure: AgentFailureClassification = {
      kind: "quota_exhausted",
      message:
        "You've hit your usage limit. Visit https://example.com to purchase more credits or try again at Aug 19th, 2026 11:29 PM.",
      retryable: false,
      retryAfterHint: "Aug 19th, 2026 11:29 PM",
    };

    const result = await resolveWith(
      errResult(failure.message, false, failure),
    );

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure).toEqual(failure);
    }
  });

  it("classifies an unclassified error result as a non-retryable backend error", async () => {
    const result = await resolveWith(errResult("backend exploded"));

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure).toEqual({
        kind: "backend_error",
        message: "backend exploded",
        retryable: false,
      });
    }
  });

  it("classifies an aborted turn without a classification as aborted", async () => {
    const result = await resolveWith(errResult("turn cancelled", true));

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure.kind).toBe("aborted");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("classifies a structured-output parse failure as retryable schema validation", async () => {
    const result = await resolveWith(
      structuredOk({ conflicts: [{ file: "x" }] }),
    );

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure.kind).toBe("schema_validation");
      expect(result.failure.retryable).toBe(true);
      expect(result.failure.message.length).toBeGreaterThan(0);
    }
  });

  it("makes a timed-out resolver turn retryable, overriding the backend's verdict", async () => {
    // What the backend classifiers hand back for a timed-out turn: not
    // retryable, because a generic conversation turn may have half-run.
    const backendVerdict: AgentFailureClassification = {
      kind: "timeout",
      message:
        "executeWorkflowTaskRun: timed out after 900000ms (conversation conv-conflicts-1)",
      retryable: false,
    };

    const result = await resolveWith(
      errResult(backendVerdict.message, false, backendVerdict),
    );

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure).toEqual({ ...backendVerdict, retryable: true });
    }
  });

  it("classifies a thrown dispatch failure as infrastructure", async () => {
    const result = await resolveWith(new Error("conversation actor exploded"));

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure).toEqual({
        kind: "backend_error",
        message: "conversation actor exploded",
        retryable: false,
      });
    }
  });

  it("reports a resolver that ran but left the conflict unresolved as unresolved", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const { resolveConflicts } = createConflictResolver(
      createTestDeps({
        executeWorkflowTaskRun,
        listUnmergedFiles: async () => ["src/index.ts"],
      }),
    );

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.error).toContain("src/index.ts");
      expect(result.partialConflicts).toEqual(SAMPLE_ENTRIES);
    }
  });
});

describe("analyzeConflicts outcome classification", () => {
  it("carries the backend's classification when the analysis turn failed", async () => {
    const failure: AgentFailureClassification = {
      kind: "quota_exhausted",
      message: "You've hit your usage limit.",
      retryable: false,
    };
    const executeWorkflowTaskRun = vi
      .fn()
      .mockResolvedValue(errResult(failure.message, false, failure));
    const { analyzeConflicts } = createConflictResolver(
      createTestDeps({ executeWorkflowTaskRun }),
    );

    const result = await analyzeConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure).toEqual(failure);
    }
  });

  it("classifies an unparseable analysis turn as retryable schema validation", async () => {
    const executeWorkflowTaskRun = vi
      .fn()
      .mockResolvedValue(structuredOk({ conflicts: [{ file: "x" }] }));
    const { analyzeConflicts } = createConflictResolver(
      createTestDeps({ executeWorkflowTaskRun }),
    );

    const result = await analyzeConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure.kind).toBe("schema_validation");
      expect(result.failure.retryable).toBe(true);
    }
  });
});

describe("resolveConflicts ground-truth verification", () => {
  it("returns unresolved when git still reports unmerged paths after the agent claims resolution", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));

    const deps = createTestDeps({
      executeWorkflowTaskRun,
      listUnmergedFiles: async () => ["package.json"],
    });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.error).toContain("package.json");
      expect(result.error).toContain("unresolved");
      expect(result.partialConflicts).toEqual(SAMPLE_ENTRIES);
    }
  });

  it("returns unresolved when a previously-conflicted file still contains conflict markers", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));

    const markerContent = [
      "{",
      '  "scripts": {',
      "<<<<<<< HEAD",
      '    "export": "bun run src/cli/export.ts"',
      "=======",
      '    "ingest": "bun run src/cli/ingest.ts"',
      ">>>>>>> csm/other-branch",
      "  }",
      "}",
    ].join("\n");

    const deps = createTestDeps({
      executeWorkflowTaskRun,
      listUnmergedFiles: async () => [],
      readWorktreeFile: async (_worktreePath, file) =>
        file === "package.json" ? markerContent : null,
    });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      conflictFiles: ["package.json"],
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.error).toContain("conflict markers");
      expect(result.error).toContain("package.json");
      expect(result.partialConflicts).toEqual(SAMPLE_ENTRIES);
    }
  });

  it("scans the agent's claimed entry files even when the caller passes no conflictFiles", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));

    const deps = createTestDeps({
      executeWorkflowTaskRun,
      readWorktreeFile: async (_worktreePath, file) =>
        file === "src/index.ts" ? "<<<<<<< HEAD\nours\n=======\n" : null,
    });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.error).toContain("src/index.ts");
    }
  });

  it("returns unresolved for a marker-bearing tracked file the agent never claimed", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));

    const deps = createTestDeps({
      executeWorkflowTaskRun,
      // Staged by the agent, mentioned by nobody: neither the merge's conflict
      // list nor the agent's own entries name it.
      listTrackedMarkerFiles: async () => ["src/unclaimed.ts"],
    });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      conflictFiles: ["package.json"],
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.error).toContain("src/unclaimed.ts");
      expect(result.partialConflicts).toEqual(SAMPLE_ENTRIES);
    }
  });

  it("returns resolved when no unmerged paths and no markers remain", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));

    const deps = createTestDeps({
      executeWorkflowTaskRun,
      readWorktreeFile: async () => '{ "scripts": { "export": "x" } }',
    });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      conflictFiles: ["package.json"],
    });

    expect(result.status).toBe("resolved");
  });

  it("returns unresolved when the ground-truth check itself cannot run", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));

    const deps = createTestDeps({
      executeWorkflowTaskRun,
      listUnmergedFiles: async () => {
        throw new Error("not a git repository");
      },
    });
    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.error).toContain("not a git repository");
    }
  });
});

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

  it("pins the analysis turn to the merge worktree (worktreePath forwarded to executeWorkflowTaskRun)", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));

    const deps = createTestDeps({ executeWorkflowTaskRun });
    const { analyzeConflicts } = createConflictResolver(deps);

    await analyzeConflicts({
      worktreePath: "/projects/repo/.worktrees/lane-feature",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.worktreePath).toBe("/projects/repo/.worktrees/lane-feature");
  });

  it("appends the incoming-changes section to the analysis prompt when targetBranch is provided", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(structuredOk({ conflicts: SAMPLE_ENTRIES }));
    const buildIncomingChangesSection = vi
      .fn()
      .mockResolvedValue("Incoming commits from `main`:\n- aaaa111 subject");
    const deps = createTestDeps({
      executeWorkflowTaskRun,
      buildIncomingChangesSection,
    });
    const { analyzeConflicts } = createConflictResolver(deps);

    await analyzeConflicts({
      worktreePath: "/tmp/worktree",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      targetBranch: "main",
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Incoming commits from `main`");
  });

  it("includes the resolution context section in the analysis prompt when provided", async () => {
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
      resolutionContext: "The session migrated all config reads to Zod v4.",
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Context about the changes being merged");
    expect(input.prompt).toContain(
      "The session migrated all config reads to Zod v4.",
    );
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

  it("returns an infrastructure outcome on backend error", async () => {
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

    expect(result.status).toBe("infrastructure");
    if (result.status === "infrastructure") {
      expect(result.failure.message).toContain("SDK down");
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

// ============================================================
// F5 pin: the shared structured-output chain widens conflict-resolution's
// rejection behavior — an INVALID native candidate no longer hard-fails; the
// chain falls through to a schema-valid raw/fenced text candidate in the same
// turn. This widening is approved (2026-07-13 addendum to the Phase 1 slice
// designs) and pinned here at the conflict-resolution consumer so a
// "stop after invalid native" regression fails the suite.
// ============================================================

describe("conflict-resolution invalid-native fall-through (F5 pin)", () => {
  it("accepts a valid fenced-JSON text candidate after an invalid native one", () => {
    const invalidNative = { conflicts: [{ file: "x" }] };
    const validFencedText = [
      "I resolved the conflicts:",
      "```json",
      JSON.stringify({ conflicts: SAMPLE_ENTRIES }, null, 2),
      "```",
    ].join("\n");

    const result = parseConflictEntries(validFencedText, invalidNative);

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.conflicts).toEqual(SAMPLE_ENTRIES);
    }
  });

  it("accepts a valid raw-JSON text candidate after an invalid native one", () => {
    const invalidNative = { conflicts: [{ file: "x" }] };
    const validRawText = JSON.stringify({ conflicts: SAMPLE_ENTRIES });

    const result = parseConflictEntries(validRawText, invalidNative);

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.conflicts).toEqual(SAMPLE_ENTRIES);
    }
  });

  it("still fails when the invalid native candidate has no recoverable text", () => {
    const invalidNative = { conflicts: [{ file: "x" }] };

    const result = parseConflictEntries(
      "prose with no JSON at all",
      invalidNative,
    );

    expect("error" in result).toBe(true);
  });
});
