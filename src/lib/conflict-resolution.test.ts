import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Mock modules before importing the module under test
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("./config", () => ({
  readConfig: vi.fn(),
}));

vi.mock("./logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Helper: create a mock async generator that yields the given messages
async function* mockQueryStream(
  messages: SDKMessage[],
): AsyncGenerator<SDKMessage> {
  for (const msg of messages) yield msg;
}

// Import mocked modules to configure them in tests
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readConfig } from "./config";
import { resolveConflicts } from "./conflict-resolution";

const mockQuery = vi.mocked(query);
const mockReadConfig = vi.mocked(readConfig);

describe("conflict-resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default config mock
    mockReadConfig.mockResolvedValue({
      baseDir: "/home/user/projects",
      ignorePatterns: [],
      stateFilePath: "/tmp/state.json",
      claudeTimeoutMs: 60_000,
      defaultModel: "opus",
    });
  });

  it("successfully extracts ConflictEntry[] from a mock Claude response with a JSON code fence", async () => {
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

    const assistantText = `I've analyzed and resolved all merge conflicts. Here's the structured analysis:

\`\`\`json
${JSON.stringify(conflictEntries, null, 2)}
\`\`\`

All conflicts have been resolved and staged.`;

    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "test-session",
      } as SDKMessage,
      {
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
        },
      } as SDKMessage,
      {
        type: "result",
        subtype: "success",
        session_id: "test-session",
        total_cost_usd: 0.01,
        duration_ms: 1000,
        num_turns: 1,
      } as SDKMessage,
    ];

    mockQuery.mockReturnValue(
      mockQueryStream(messages) as ReturnType<typeof query>,
    );

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

    // Verify query was called with correct options
    expect(mockQuery).toHaveBeenCalledOnce();
    const callArgs = mockQuery.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs["options"]).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: "/tmp/worktree",
      persistSession: false,
    });
  });

  it("returns failed status when no JSON code fence is found", async () => {
    const assistantText =
      "I resolved all conflicts but forgot to include the JSON output.";

    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "test-session",
      } as SDKMessage,
      {
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
        },
      } as SDKMessage,
      {
        type: "result",
        subtype: "success",
        session_id: "test-session",
        total_cost_usd: 0.01,
        duration_ms: 500,
        num_turns: 1,
      } as SDKMessage,
    ];

    mockQuery.mockReturnValue(
      mockQueryStream(messages) as ReturnType<typeof query>,
    );

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("No JSON code fence found");
    }
  });

  it("returns failed status when Zod parse fails (malformed JSON)", async () => {
    // JSON that doesn't match conflictEntrySchema — missing required fields
    const malformedEntries = [
      {
        file: "src/index.ts",
        // missing description, resolution, rationale
      },
    ];

    const assistantText = `Here's the analysis:

\`\`\`json
${JSON.stringify(malformedEntries, null, 2)}
\`\`\``;

    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "test-session",
      } as SDKMessage,
      {
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
        },
      } as SDKMessage,
      {
        type: "result",
        subtype: "success",
        session_id: "test-session",
        total_cost_usd: 0.01,
        duration_ms: 500,
        num_turns: 1,
      } as SDKMessage,
    ];

    mockQuery.mockReturnValue(
      mockQueryStream(messages) as ReturnType<typeof query>,
    );

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("Failed to parse conflict entries");
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

    const assistantText = `\`\`\`json
${JSON.stringify(conflictEntries, null, 2)}
\`\`\``;

    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "test-session",
      } as SDKMessage,
      {
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
        },
      } as SDKMessage,
      {
        type: "result",
        subtype: "success",
        session_id: "test-session",
        total_cost_usd: 0.02,
        duration_ms: 2000,
        num_turns: 2,
      } as SDKMessage,
    ];

    mockQuery.mockReturnValue(
      mockQueryStream(messages) as ReturnType<typeof query>,
    );

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
    expect(mockQuery).toHaveBeenCalledOnce();
    const callArgs = mockQuery.mock.calls[0]![0] as Record<string, unknown>;
    const prompt = callArgs["prompt"] as string;

    expect(prompt).toContain("src/index.ts");
    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("src/utils.ts");
    expect(prompt).toContain("REJECTED");
    expect(prompt).toContain("Use the feature branch version instead");
    expect(prompt).toContain("src/config.ts");
    expect(prompt).toContain("PENDING");
  });

  it("returns failed status on SDK error/exception", async () => {
    mockQuery.mockImplementation(() => {
      throw new Error("SDK connection failed");
    });

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("SDK connection failed");
    }
  });

  it("returns failed status when SDK stream throws during iteration", async () => {
    // Simulate a stream that yields one message then throws
    async function* failingStream(): AsyncGenerator<SDKMessage> {
      yield {
        type: "system",
        subtype: "init",
        session_id: "test-session",
      } as SDKMessage;
      throw new Error("Stream interrupted");
    }

    mockQuery.mockReturnValue(failingStream() as ReturnType<typeof query>);

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("Stream interrupted");
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

    const assistantText = `First attempt:

\`\`\`json
${JSON.stringify(firstEntries, null, 2)}
\`\`\`

Wait, let me update that:

\`\`\`json
${JSON.stringify(lastEntries, null, 2)}
\`\`\``;

    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "test-session",
      } as SDKMessage,
      {
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
        },
      } as SDKMessage,
      {
        type: "result",
        subtype: "success",
        session_id: "test-session",
        total_cost_usd: 0.01,
        duration_ms: 1000,
        num_turns: 1,
      } as SDKMessage,
    ];

    mockQuery.mockReturnValue(
      mockQueryStream(messages) as ReturnType<typeof query>,
    );

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.file).toBe("src/final.ts");
    }
  });

  it("collects text from multiple assistant messages", async () => {
    const conflictEntries = [
      {
        file: "src/index.ts",
        description: "Import conflict",
        resolution: "Merged imports",
        rationale: "Both needed",
      },
    ];

    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "test-session",
      } as SDKMessage,
      {
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Analyzing conflicts..." },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "git diff --name-only --diff-filter=U" },
            },
          ],
        },
      } as SDKMessage,
      {
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `All resolved:\n\n\`\`\`json\n${JSON.stringify(conflictEntries, null, 2)}\n\`\`\``,
            },
          ],
        },
      } as SDKMessage,
      {
        type: "result",
        subtype: "success",
        session_id: "test-session",
        total_cost_usd: 0.03,
        duration_ms: 3000,
        num_turns: 3,
      } as SDKMessage,
    ];

    mockQuery.mockReturnValue(
      mockQueryStream(messages) as ReturnType<typeof query>,
    );

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.file).toBe("src/index.ts");
    }
  });

  it("returns failed status when JSON code fence contains invalid JSON", async () => {
    const assistantText = `Here's the analysis:

\`\`\`json
{ this is not valid JSON }
\`\`\``;

    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "test-session",
      } as SDKMessage,
      {
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
        },
      } as SDKMessage,
      {
        type: "result",
        subtype: "success",
        session_id: "test-session",
        total_cost_usd: 0.01,
        duration_ms: 500,
        num_turns: 1,
      } as SDKMessage,
    ];

    mockQuery.mockReturnValue(
      mockQueryStream(messages) as ReturnType<typeof query>,
    );

    const result = await resolveConflicts({
      worktreePath: "/tmp/worktree",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("Failed to parse");
    }
  });
});
