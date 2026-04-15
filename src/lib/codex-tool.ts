/**
 * Codex MCP tool — lets Claude invoke the OpenAI Codex SDK as a one-shot sub-agent.
 *
 * Exposes a single `run_codex` tool that runs Codex in the session worktree
 * via the task runner abstraction, returning a structured JSON response.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { codexReasoningEffortSchema } from "./schemas";
import type { CodexReasoningEffort } from "@/types";
import { createLogger } from "./logging";
import { getTaskRunner } from "@/lib/agent-backends/registry";

const logger = createLogger("codex-tool");

const CODEX_TIMEOUT_MS = 600_000;

// ============================================================
// Public Types
// ============================================================

export interface CodexToolContext {
  worktreePath: string;
  sessionName: string;
  defaultModel?: string;
  defaultReasoningEffort?: CodexReasoningEffort;
  /** Timeout in ms. 0 means no timeout. Undefined falls back to CODEX_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface CodexRunResult {
  response: string | null;
  error: string | null;
  timedOut: boolean;
}

export interface CodexToolDeps {
  ensureDir(dirPath: string): Promise<void>;
  runCodex(input: {
    prompt: string;
    workingDirectory: string;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    outputSchema: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<CodexRunResult>;
}

// ============================================================
// Output Schema
// ============================================================

const CODEX_OUTPUT_DIR = "memory-bank/codex";

export const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    referenceDocuments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          description: { type: "string" },
        },
        required: ["filePath", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "referenceDocuments"],
  additionalProperties: false,
} as const;

// ============================================================
// SDK Runner (via task runner abstraction)
// ============================================================

export async function runCodexDefault(input: {
  prompt: string;
  workingDirectory: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
}): Promise<CodexRunResult> {
  const runner = getTaskRunner("codex");

  try {
    const result = await runner.run({
      workingDirectory: input.workingDirectory,
      prompt: input.prompt,
      modelId: input.model,
      reasoningEffort: input.reasoningEffort,
      outputSchema: input.outputSchema,
      autonomous: true,
      timeoutMs: input.timeoutMs,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
      webSearchMode: "disabled",
    });

    if (result.timedOut) {
      return { response: null, error: null, timedOut: true };
    }
    if (result.error) {
      return { response: null, error: result.error, timedOut: false };
    }
    return { response: result.text, error: null, timedOut: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { response: null, error: msg, timedOut: false };
  }
}

export const defaultCodexToolDeps: CodexToolDeps = {
  ensureDir: async (dirPath: string) => {
    await mkdir(dirPath, { recursive: true });
  },
  runCodex: runCodexDefault,
};

// ============================================================
// Prompt Wrapping
// ============================================================

const CODEX_PROMPT_PREAMBLE = `You MUST write all detailed output as files in the \`memory-bank/codex/\` directory (relative to the workspace root). Use markdown files primarily, but other formats are acceptable when appropriate.

Your response will be constrained to a JSON schema with two fields:
- "summary": A concise summary of what you did and the results. Maximum 1000 characters. This is the only text the caller sees directly, so make it informative.
- "referenceDocuments": An array of documents you created, each with "filePath" (path relative to workspace root) and "description" (what the file contains and when it should be read).

Write detailed analysis, code examples, plans, and explanations to files — do NOT put them in the summary.`;

export function wrapCodexPrompt(prompt: string): string {
  return `${CODEX_PROMPT_PREAMBLE}\n\n---\n\nTask:\n${prompt}`;
}

// ============================================================
// Structured Response Parsing
// ============================================================

export interface CodexStructuredResponse {
  summary: string;
  referenceDocuments: Array<{
    filePath: string;
    description: string;
  }>;
}

export function parseCodexStructuredResponse(
  text: string,
): CodexStructuredResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.summary !== "string") return null;
  if (!Array.isArray(obj.referenceDocuments)) return null;

  for (const doc of obj.referenceDocuments) {
    if (typeof doc !== "object" || doc === null) return null;
    const d = doc as Record<string, unknown>;
    if (typeof d.filePath !== "string" || typeof d.description !== "string")
      return null;
  }

  return {
    summary: obj.summary,
    referenceDocuments: (
      obj.referenceDocuments as Array<Record<string, unknown>>
    ).map((d) => ({
      filePath: d.filePath as string,
      description: d.description as string,
    })),
  };
}

// ============================================================
// Prompt Hint Helper
// ============================================================

export function getCodexToolPromptHint(enabled: boolean): string | null {
  if (!enabled) return null;
  return `The \`run_codex\` tool is available. It runs OpenAI Codex locally in the same worktree as a one-shot stateless invocation. The tool returns a JSON object with a \`summary\` field (concise result summary) and a \`referenceDocuments\` array (files Codex created with \`filePath\` and \`description\`). Use the Read tool to review any reference documents when the summary indicates relevant content.`;
}

const runCodexInputSchema = {
  prompt: z.string().trim().min(1).describe("The task instruction for Codex"),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Model override (e.g., o3, gpt-5-codex, o4-mini)"),
  reasoning_effort: codexReasoningEffortSchema
    .optional()
    .describe("Reasoning effort override (minimal, low, medium, high, xhigh)"),
};

const CODEX_TOOL_DESCRIPTION =
  "Run a one-shot OpenAI Codex task in the current session worktree. Codex operates autonomously with full access (no sandbox). It does not resume or persist conversation state. Returns a JSON object with `summary` (concise result summary) and `referenceDocuments` (array of files Codex created for detailed review, each with `filePath` and `description`). If Codex fails to produce structured output, falls back to returning raw text.";

function createRunCodexHandler(context: CodexToolContext, deps: CodexToolDeps) {
  return async (args: {
    prompt: string;
    model?: string;
    reasoning_effort?: CodexReasoningEffort;
  }) => {
    const effectiveModel = args.model ?? context.defaultModel;
    const effectiveReasoningEffort =
      args.reasoning_effort ?? context.defaultReasoningEffort;

    // Ensure output directory exists for Codex to write reference files.
    const outputDir = path.join(context.worktreePath, CODEX_OUTPUT_DIR);
    await deps.ensureDir(outputDir);

    logger.info("codex.exec", {
      sessionName: context.sessionName,
      model: effectiveModel ?? "default",
      reasoningEffort: effectiveReasoningEffort ?? "default",
    });

    const effectiveTimeoutMs = context.timeoutMs ?? CODEX_TIMEOUT_MS;

    const result = await deps.runCodex({
      prompt: wrapCodexPrompt(args.prompt),
      workingDirectory: context.worktreePath,
      model: effectiveModel,
      reasoningEffort: effectiveReasoningEffort,
      outputSchema: CODEX_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      timeoutMs: effectiveTimeoutMs,
    });

    if (result.timedOut) {
      return errorResult(
        `Codex execution timed out after ${effectiveTimeoutMs / 1000} seconds.`,
      );
    }

    if (result.error) {
      if (result.error.includes("not found")) {
        return errorResult(
          "Codex CLI is not installed or not on PATH. Install @openai/codex on the host machine and authenticate it before enabling this tool.",
        );
      }
      return errorResult(`Codex execution failed: ${result.error}`);
    }

    if (!result.response) {
      return errorResult("Codex completed without emitting a final response.");
    }

    logger.info("codex.success", {
      sessionName: context.sessionName,
      responseLength: result.response.length,
    });

    const structured = parseCodexStructuredResponse(result.response);
    if (structured) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(structured),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: result.response }],
    };
  };
}

export function registerCodexTool(
  server: McpServer,
  context: CodexToolContext,
  deps: CodexToolDeps = defaultCodexToolDeps,
): void {
  server.registerTool(
    "run_codex",
    {
      description: CODEX_TOOL_DESCRIPTION,
      inputSchema: runCodexInputSchema,
    },
    createRunCodexHandler(context, deps),
  );
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
