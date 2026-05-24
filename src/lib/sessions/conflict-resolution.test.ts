import { describe, it, expect, vi } from "vitest";
import {
  createConflictResolver,
  type ConflictResolutionDeps,
} from "./conflict-resolution";
import type { AgentTaskRunner, AgentTaskResult } from "../agent-backends/task";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";

// ============================================================
// Test Helpers
// ============================================================

function createMockRunner(result: Partial<AgentTaskResult>): AgentTaskRunner {
  return {
    backend: "claude",
    run: vi.fn().mockResolvedValue({
      backendRef: null,
      text: null,
      structuredOutput: undefined,
      usage: null,
      error: null,
      timedOut: false,
      ...result,
    }),
  };
}

function createTestDeps(
  overrides?: Partial<ConflictResolutionDeps>,
): ConflictResolutionDeps {
  return {
    getTaskRunner: vi
      .fn()
      .mockReturnValue(
        createMockRunner({ text: null }),
      ) as ConflictResolutionDeps["getTaskRunner"],
    readConfig: vi.fn().mockResolvedValue({
      baseDir: "/home/user/projects",
      ignorePatterns: [],
      claudeTimeoutMs: 60_000,
      defaultModel: "opus",
    }) as unknown as ConflictResolutionDeps["readConfig"],
    ...overrides,
  };
}

describe("conflict-resolution", () => {
  it("successfully extracts ConflictEntry[] from a fenced JSON code block in text", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Conflicting import statements",
        resolution: "Kept both imports in correct order",
        rationale:
          "Both imports are needed: one from main and one from the feature branch",
      },
      {
        file: "src/utils.ts",
        description: "Different function implementations",
        resolution: "Merged both implementations, keeping feature branch logic",
        rationale:
          "Feature branch had the more complete implementation with error handling",
      },
    ];

    const text = `I've analyzed and resolved all merge conflicts. Here's the structured analysis:

\`\`\`json
${JSON.stringify({ conflicts: conflictEntries }, null, 2)}
\`\`\`

All conflicts have been resolved and staged.`;

    const runner = createMockRunner({ text });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.conflicts).toHaveLength(2);
      expect(result.conflicts[0]!.file).toBe("src/index.ts");
      expect(result.conflicts[0]!.description).toBe(
        "Conflicting import statements",
      );
      expect(result.conflicts[0]!.resolution).toBe(
        "Kept both imports in correct order",
      );
      expect(result.conflicts[0]!.rationale).toBe(
        "Both imports are needed: one from main and one from the feature branch",
      );
      expect(result.conflicts[1]!.file).toBe("src/utils.ts");
    }

    // Verify getTaskRunner was called with "claude"
    expect(deps.getTaskRunner).toHaveBeenCalledWith("claude");
    // Verify runner.run was called with correct options
    expect(runner.run).toHaveBeenCalledOnce();
    const callArgs = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArgs.workingDirectory).toBe("/tmp/worktree");
    expect(callArgs.autonomous).toBe(true);
  });

  it("prefers structured output over text parsing", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Import conflict",
        resolution: "Merged imports",
        rationale: "Both needed",
      },
    ];

    const runner = createMockRunner({
      text: "some text without json",
      structuredOutput: { conflicts: conflictEntries },
    });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.file).toBe("src/index.ts");
    }
  });

  it("passes a JSON schema with type:object to the SDK task runner (Anthropic tool input_schema requirement)", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Import conflict",
        resolution: "Merged imports",
        rationale: "Both imports are required",
      },
    ];

    const runner = createMockRunner({
      text: "not json",
      structuredOutput: { conflicts: conflictEntries },
    });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("resolved");
    const callArgs = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Anthropic tool input_schema must be type:"object" — array at root is rejected with HTTP 400.
    expect(callArgs.outputSchema).toMatchObject({
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
  });

  it("falls back to raw JSON parse when text is valid JSON", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Conflict",
        resolution: "Resolved",
        rationale: "Reason",
      },
    ];

    const runner = createMockRunner({
      text: JSON.stringify({ conflicts: conflictEntries }),
    });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.conflicts).toHaveLength(1);
    }
  });

  it("returns failed status when no JSON code fence is found and text is not JSON", async () => {
    const runner = createMockRunner({
      text: "I resolved all conflicts but forgot to include the JSON output.",
    });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("structured output failed validation");
    }
  });

  it("returns failed status when Zod parse fails (malformed JSON)", async () => {
    const malformedEntries = [
      {
        file: "src/index.ts",
        // missing description, resolution, rationale
      },
    ];

    const text = `Here's the analysis:

\`\`\`json
${JSON.stringify(malformedEntries, null, 2)}
\`\`\``;

    const runner = createMockRunner({ text });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("structured output failed validation");
    }
  });

  it("handles decisions parameter by including them in the prompt", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Import conflict",
        resolution: "Kept user-preferred imports",
        rationale: "User approved this resolution",
      },
    ];

    const text = `\`\`\`json
${JSON.stringify({ conflicts: conflictEntries }, null, 2)}
\`\`\``;

    const runner = createMockRunner({ text });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const decisions = [
      { file: "src/index.ts", decision: "approved" as const },
      {
        file: "src/utils.ts",
        decision: "rejected" as const,
        feedback: "Use the feature branch version instead",
      },
      { file: "src/config.ts", decision: "pending" as const },
    ];

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
      decisions,
    });

    expect(result.status).toBe("resolved");

    // Verify the prompt includes decision information
    const callArgs = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const prompt = callArgs.prompt as string;

    expect(prompt).toContain("src/index.ts");
    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("src/utils.ts");
    expect(prompt).toContain("REJECTED");
    expect(prompt).toContain("Use the feature branch version instead");
    expect(prompt).toContain("src/config.ts");
    expect(prompt).toContain("PENDING");
  });

  it("returns failed status on task runner error", async () => {
    const runner = createMockRunner({
      error: "SDK connection failed",
    });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("SDK connection failed");
    }
  });

  it("returns failed status when getTaskRunner throws", async () => {
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockImplementation(() => {
        throw new Error("No task runner registered");
      }),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("No task runner registered");
    }
  });

  it("uses the last JSON code fence when multiple are present", async () => {
    const firstEntries = [
      {
        file: "src/old.ts",
        description: "Old analysis",
        resolution: "Old resolution",
        rationale: "Old rationale",
      },
    ];

    const lastEntries = [
      {
        file: "src/final.ts",
        description: "Final analysis",
        resolution: "Final resolution",
        rationale: "Final rationale",
      },
    ];

    const text = `First attempt:

\`\`\`json
${JSON.stringify({ conflicts: firstEntries }, null, 2)}
\`\`\`

Wait, let me update that:

\`\`\`json
${JSON.stringify({ conflicts: lastEntries }, null, 2)}
\`\`\``;

    const runner = createMockRunner({ text });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.file).toBe("src/final.ts");
    }
  });

  it("returns failed status when JSON code fence contains invalid JSON", async () => {
    const text = `Here's the analysis:

\`\`\`json
{ this is not valid JSON }
\`\`\``;

    const runner = createMockRunner({ text });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { resolveConflicts } = createConflictResolver(deps);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("structured output failed validation");
    }
  });
});

// ============================================================
// analyzeConflicts tests
// ============================================================

describe("analyzeConflicts", () => {
  it("successfully extracts ConflictEntry[] from analysis-only response", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Conflicting import statements",
        resolution: "Keep both imports in correct order",
        rationale:
          "Both imports are needed: one from main and one from the feature branch",
      },
    ];

    const text = `I've analyzed the merge conflicts. Here's the structured analysis:

\`\`\`json
${JSON.stringify({ conflicts: conflictEntries }, null, 2)}
\`\`\``;

    const runner = createMockRunner({ text });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { analyzeConflicts } = createConflictResolver(deps);

    const result = await analyzeConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("analyzed");
    if (result.status === "analyzed") {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.file).toBe("src/index.ts");
      expect(result.conflicts[0]!.description).toBe(
        "Conflicting import statements",
      );
      expect(result.conflicts[0]!.resolution).toBe(
        "Keep both imports in correct order",
      );
    }
  });

  it("uses analysis-only system instructions", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Conflict",
        resolution: "Proposed fix",
        rationale: "Reason",
      },
    ];

    const text = `\`\`\`json
${JSON.stringify({ conflicts: conflictEntries }, null, 2)}
\`\`\``;

    const runner = createMockRunner({ text });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { analyzeConflicts } = createConflictResolver(deps);

    await analyzeConflicts({ worktreePath: "/tmp/worktree" });

    // Verify system instructions contain analysis-only directives
    const callArgs = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const instructions = callArgs.systemInstructions as string[];
    const combined = instructions.join("\n");

    expect(combined).toContain("DO NOT");
    expect(combined).not.toContain("Edit each file");
    expect(combined).not.toContain("Stage each resolved file");
  });

  it("returns failed status when no JSON code fence is found", async () => {
    const runner = createMockRunner({
      text: "I analyzed but forgot the JSON output.",
    });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { analyzeConflicts } = createConflictResolver(deps);

    const result = await analyzeConflicts({ worktreePath: "/tmp/worktree" });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("structured output failed validation");
    }
  });

  it("returns failed status on task runner error", async () => {
    const runner = createMockRunner({
      error: "SDK connection failed",
    });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { analyzeConflicts } = createConflictResolver(deps);

    const result = await analyzeConflicts({ worktreePath: "/tmp/worktree" });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("SDK connection failed");
    }
  });
});

describe("conflict-resolution Task 6.3 parity (executeAgentCall route)", () => {
  it("routes resolveConflicts through deps.executeAgentCall as kind=task_run with write_capable", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Conflict",
        resolution: "Resolved",
        rationale: "Reason",
      },
    ];
    const text = `\`\`\`json\n${JSON.stringify({ conflicts: conflictEntries })}\n\`\`\``;
    const runner = createMockRunner({ text });
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);

    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
      executeAgentCall: executeAgentCallSpy,
    });

    const { resolveConflicts } = createConflictResolver(deps);
    const result = await resolveConflicts({ worktreePath: "/tmp/worktree" });

    expect(result.status).toBe("resolved");
    expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
    const [request] = executeAgentCallSpy.mock.calls[0]!;
    expect(request).toMatchObject({
      kind: "task_run",
      backend: "claude",
      writeCapability: "write_capable",
    });
  });

  it("routes analyzeConflicts through deps.executeAgentCall as kind=task_run with read_only", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Conflict",
        resolution: "Proposed",
        rationale: "Reason",
      },
    ];
    const text = `\`\`\`json\n${JSON.stringify({ conflicts: conflictEntries })}\n\`\`\``;
    const runner = createMockRunner({ text });
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);

    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
      executeAgentCall: executeAgentCallSpy,
    });

    const { analyzeConflicts } = createConflictResolver(deps);
    const result = await analyzeConflicts({ worktreePath: "/tmp/worktree" });

    expect(result.status).toBe("analyzed");
    expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
    const [request] = executeAgentCallSpy.mock.calls[0]!;
    expect(request).toMatchObject({
      kind: "task_run",
      backend: "claude",
      writeCapability: "read_only",
    });
  });
});
