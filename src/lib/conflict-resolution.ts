import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { conflictEntrySchema } from "./schemas";
import type { ConflictEntry, ConflictDecisionInput } from "@/lib/schemas";
import { readConfig as defaultReadConfig } from "./config";
import { createLogger } from "./logging";

const logger = createLogger("conflict-resolution");

// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/sdk-env";

// ============================================================
// Dependency Injection
// ============================================================

export interface ConflictResolutionDeps {
  query: typeof defaultQuery;
  readConfig: typeof defaultReadConfig;
}

const defaultDeps: ConflictResolutionDeps = {
  query: defaultQuery,
  readConfig: defaultReadConfig,
};

// ============================================================
// Public Types
// ============================================================

export type ConflictResolutionResult =
  | { status: "resolved"; conflicts: ConflictEntry[] }
  | { status: "failed"; error: string; partialConflicts?: ConflictEntry[] };

// ============================================================
// System Prompt
// ============================================================

const CONFLICT_RESOLUTION_INSTRUCTIONS = `You are a merge conflict resolution specialist. Your task is to resolve all git merge conflicts in this worktree.

Follow these steps precisely:

1. Run \`git diff --name-only --diff-filter=U\` to find all conflicted files.
2. Read each conflicted file and analyze the conflict markers (<<<<<<< HEAD, =======, >>>>>>> markers).
3. For each file, determine the best resolution by understanding the intent of both sides.
4. Edit each file to remove all conflict markers and produce the correct merged content.
5. Stage each resolved file with \`git add <file>\`.
6. After resolving ALL conflicts, output a single JSON code fence with your analysis using exactly this schema:

\`\`\`json
[
  {
    "file": "path/to/file",
    "description": "Brief description of what conflicted",
    "resolution": "What you chose and how you merged it",
    "rationale": "Why this resolution is correct"
  }
]
\`\`\`

IMPORTANT:
- Resolve ALL conflicted files before outputting the JSON.
- The JSON must be a valid array of objects with exactly: file, description, resolution, rationale fields.
- Every conflict marker must be removed — no <<<<<<< or ======= or >>>>>>> markers should remain.
- Stage every resolved file with git add.`;

// ============================================================
// Decision Prompt Builder
// ============================================================

function buildDecisionsPrompt(decisions: ConflictDecisionInput[]): string {
  const lines: string[] = [
    "\nYou have per-file instructions from a human reviewer:",
    "",
  ];

  for (const d of decisions) {
    switch (d.decision) {
      case "approved":
        lines.push(
          `- **${d.file}**: APPROVED — resolve this file freely using your best judgment.`,
        );
        break;
      case "rejected":
        lines.push(
          `- **${d.file}**: REJECTED — the previous resolution was not acceptable.${d.feedback ? ` User feedback: "${d.feedback}"` : ""} Incorporate the user's guidance when resolving this file.`,
        );
        break;
      case "pending":
        lines.push(
          `- **${d.file}**: PENDING — no decision from the user yet. Resolve this file with extra care, preferring the safest merge strategy.`,
        );
        break;
    }
  }

  return lines.join("\n");
}

// ============================================================
// JSON Extraction
// ============================================================

/**
 * Scan text for the last ```json code fence and return its content.
 * Returns null if no code fence is found.
 */
function extractLastJsonCodeFence(text: string): string | null {
  const regex = /```json\s*\n([\s\S]*?)```/g;
  let lastMatch: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    lastMatch = match[1] ?? null;
  }

  return lastMatch?.trim() ?? null;
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Create a conflict resolver with injected dependencies.
 * Tests use this to inject mocks; production uses the default singleton export.
 */
export function createConflictResolver(
  deps: ConflictResolutionDeps = defaultDeps,
) {
  return {
    resolveConflicts: (params: {
      worktreePath: string;
      decisions?: ConflictDecisionInput[];
    }): Promise<ConflictResolutionResult> => resolveConflictsImpl(params, deps),
  };
}

/**
 * Invoke Claude Agent SDK to analyze and resolve merge conflicts in a session worktree.
 *
 * - Constructs the conflict resolution prompt
 * - Calls query() with full tool access in the session worktree
 * - Streams all messages, collecting assistant text blocks
 * - After stream completes, extracts structured ConflictEntry[] from the last JSON code fence
 * - Returns resolved status with entries on success, or failed status with error on failure
 */
export async function resolveConflicts(params: {
  worktreePath: string;
  decisions?: ConflictDecisionInput[];
}): Promise<ConflictResolutionResult> {
  return resolveConflictsImpl(params, defaultDeps);
}

async function resolveConflictsImpl(
  params: {
    worktreePath: string;
    decisions?: ConflictDecisionInput[];
  },
  deps: ConflictResolutionDeps,
): Promise<ConflictResolutionResult> {
  const { worktreePath, decisions } = params;
  const { query, readConfig } = deps;

  logger.info("conflict-resolution.start", { worktreePath });

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to read config";
    logger.error("conflict-resolution.config_error", { error: errorMsg });
    return { status: "failed", error: errorMsg };
  }

  // Build the prompt
  let prompt =
    "Resolve all merge conflicts in this worktree. Follow the instructions in your system prompt precisely.";

  if (decisions && decisions.length > 0) {
    prompt += buildDecisionsPrompt(decisions);
  }

  // Collect all assistant text blocks across the stream
  const assistantTexts: string[] = [];

  try {
    const abortController = new AbortController();

    // Safety-net timeout: abort if resolution exceeds configured max duration
    const timeoutHandle = setTimeout(() => {
      logger.warn("conflict-resolution.timeout", {
        worktreePath,
        timeoutMs: config.claudeTimeoutMs,
      });
      abortController.abort();
    }, config.claudeTimeoutMs);

    try {
      const stream = query({
        prompt,
        options: {
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: CONFLICT_RESOLUTION_INSTRUCTIONS,
          },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          cwd: worktreePath,
          persistSession: false,
          abortController,
          settingSources: ["user", "project", "local"],
          env: { CLAUDECODE: "" },
        },
      });

      for await (const message of stream) {
        collectAssistantText(message, assistantTexts);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown SDK error";
    logger.error("conflict-resolution.sdk_error", {
      worktreePath,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg };
  }

  // Extract the structured conflict entries from the assistant's output
  const fullText = assistantTexts.join("\n");
  logger.debug("conflict-resolution.full_text_length", {
    length: fullText.length,
  });

  const jsonContent = extractLastJsonCodeFence(fullText);
  if (!jsonContent) {
    logger.warn("conflict-resolution.no_json_fence", { worktreePath });
    return {
      status: "failed",
      error: "No JSON code fence found in Claude's response",
    };
  }

  // Parse the JSON content
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Invalid JSON";
    logger.warn("conflict-resolution.json_parse_error", {
      worktreePath,
      error: errorMsg,
    });
    return {
      status: "failed",
      error: `Failed to parse conflict entries JSON: ${errorMsg}`,
    };
  }

  // Validate with Zod schema
  const parseResult = z.array(conflictEntrySchema).safeParse(parsed);
  if (!parseResult.success) {
    logger.warn("conflict-resolution.zod_parse_error", {
      worktreePath,
      error: parseResult.error.message,
    });
    return {
      status: "failed",
      error: `Failed to parse conflict entries: ${parseResult.error.message}`,
    };
  }

  const conflicts = parseResult.data;
  logger.info("conflict-resolution.resolved", {
    worktreePath,
    conflictCount: conflicts.length,
  });

  return { status: "resolved", conflicts };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Extract text content from an assistant message and append to the accumulator.
 */
function collectAssistantText(message: SDKMessage, texts: string[]): void {
  if (message.type !== "assistant") return;

  const assistantMsg = message as SDKAssistantMessage;
  for (const block of assistantMsg.message.content) {
    if (block.type === "text" && "text" in block) {
      texts.push(block.text);
    }
  }
}
