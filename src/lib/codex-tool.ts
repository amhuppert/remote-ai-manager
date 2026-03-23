/**
 * Codex MCP tool — lets Claude invoke the OpenAI Codex CLI as a one-shot sub-agent.
 *
 * Exposes a single `run_codex` tool that spawns `codex exec` in the session worktree,
 * parses the JSONL output, and returns the final agent response text.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildChildEnv } from "./child-env";
import { codexReasoningEffortSchema } from "./schemas";
import type { CodexConfig, CodexReasoningEffort } from "@/types";
import { createLogger } from "./logging";

const logger = createLogger("codex-tool");

const CODEX_TIMEOUT_MS = 600_000;
const SIGKILL_GRACE_MS = 5_000;

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

export interface CodexToolDeps {
  buildChildEnv: typeof buildChildEnv;
  ensureDir: (dirPath: string) => Promise<void>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  runCodexExec: (input: {
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }) => Promise<{
    exitCode: number | null;
    stderr: string;
    timedOut: boolean;
    parseState: CodexJsonParseState;
  }>;
}

// ============================================================
// Output Schema
// ============================================================

const CODEX_OUTPUT_DIR = "memory-bank/codex";
const CODEX_SCHEMA_FILENAME = ".output-schema.json";

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

export interface CodexJsonParseState {
  lineCount: number;
  lastAgentMessage: string | null;
  lastErrorMessage: string | null;
}

// ============================================================
// JSONL Parser
// ============================================================

export function consumeCodexJsonLine(
  state: CodexJsonParseState,
  line: string,
): void {
  if (line.trim() === "") return;

  state.lineCount++;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(
      `Codex produced invalid JSONL output at line ${state.lineCount}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) return;

  const event = parsed as Record<string, unknown>;
  const eventType = event.type;

  if (eventType === "item.completed") {
    const item = event.item;
    if (typeof item === "object" && item !== null) {
      const itemObj = item as Record<string, unknown>;
      if (
        itemObj.type === "agent_message" &&
        typeof itemObj.text === "string" &&
        itemObj.text
      ) {
        state.lastAgentMessage = itemObj.text;
      }
    }
  } else if (eventType === "error") {
    const msg =
      typeof event.message === "string"
        ? event.message
        : typeof (event.error as Record<string, unknown>)?.message === "string"
          ? ((event.error as Record<string, unknown>).message as string)
          : null;
    if (msg) state.lastErrorMessage = msg;
  } else if (eventType === "turn.failed") {
    const errorObj = event.error as Record<string, unknown> | undefined;
    const msg =
      typeof errorObj?.message === "string"
        ? errorObj.message
        : typeof event.reason === "string"
          ? (event.reason as string)
          : null;
    if (msg) state.lastErrorMessage = msg;
  }
}

export function finalizeCodexJsonParse(state: CodexJsonParseState): string {
  if (state.lastAgentMessage) return state.lastAgentMessage;
  if (state.lastErrorMessage) throw new Error(state.lastErrorMessage);
  throw new Error(
    "Codex completed without emitting a final agent_message event",
  );
}

// ============================================================
// CLI Arg Construction
// ============================================================

export function buildCodexExecArgs(input: {
  worktreePath: string;
  prompt: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  outputSchemaPath?: string;
}): string[] {
  const { worktreePath, prompt, model, reasoningEffort, outputSchemaPath } =
    input;
  return [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--ephemeral",
    "-C",
    worktreePath,
    "-c",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c",
    "sandbox_workspace_write.writable_roots=[]",
    "-c",
    "sandbox_workspace_write.network_access=true",
    ...(model ? ["-m", model] : []),
    ...(reasoningEffort
      ? ["-c", `model_reasoning_effort=${reasoningEffort}`]
      : []),
    ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
    prompt,
  ];
}

// ============================================================
// Subprocess Runner
// ============================================================

function runCodexExecDefault(input: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  parseState: CodexJsonParseState;
}> {
  return new Promise((resolve, reject) => {
    const state: CodexJsonParseState = {
      lineCount: 0,
      lastAgentMessage: null,
      lastErrorMessage: null,
    };

    let settled = false;
    let exited = false;
    let timedOut = false;
    let stderrChunks = "";
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let rl: ReturnType<typeof createInterface> | null = null;

    const child = spawn("codex", input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const closeReadline = () => {
      if (rl == null) return;
      try {
        rl.close();
      } catch {
        // best-effort cleanup
      }
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
      closeReadline();
      reject(error);
    };

    const scheduleForceKill = () => {
      if (killTimer != null) return;
      killTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        rejectOnce(new Error("Codex CLI not found"));
      } else {
        rejectOnce(err);
      }
    });

    // Stream stdout line-by-line
    rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      try {
        consumeCodexJsonLine(state, line);
      } catch (error) {
        child.kill("SIGTERM");
        scheduleForceKill();
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks += chunk.toString();
    });

    // Timeout handling (0 means no timeout)
    if (input.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        scheduleForceKill();
      }, input.timeoutMs);
    }

    child.on("close", (code) => {
      exited = true;
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
      if (killTimer != null) clearTimeout(killTimer);
      closeReadline();
      if (settled) return;
      settled = true;
      resolve({
        exitCode: code,
        stderr: stderrChunks,
        timedOut,
        parseState: state,
      });
    });
  });
}

export const defaultCodexToolDeps: CodexToolDeps = {
  buildChildEnv,
  ensureDir: async (dirPath: string) => {
    await mkdir(dirPath, { recursive: true });
  },
  writeFile: fsWriteFile,
  runCodexExec: runCodexExecDefault,
};

// ============================================================
// Feature-Gated Helper
// ============================================================

export function maybeCreateCodexToolServer(
  codexConfig: CodexConfig | undefined,
  context: CodexToolContext,
  deps: CodexToolDeps = defaultCodexToolDeps,
): McpSdkServerConfigWithInstance | null {
  if (codexConfig?.enabled !== true) return null;

  let timeoutMs: number | undefined;
  if (codexConfig.timeout === null) {
    timeoutMs = 0;
  } else if (codexConfig.timeout !== undefined) {
    timeoutMs = codexConfig.timeout * 1000;
  }

  return createCodexToolServer(
    {
      ...context,
      defaultModel: context.defaultModel ?? codexConfig.model,
      defaultReasoningEffort:
        context.defaultReasoningEffort ?? codexConfig.reasoningEffort,
      timeoutMs: context.timeoutMs ?? timeoutMs,
    },
    deps,
  );
}

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

// ============================================================
// MCP Tool Server
// ============================================================

export function createCodexToolServer(
  context: CodexToolContext,
  deps: CodexToolDeps = defaultCodexToolDeps,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "codex-tool",
    version: "1.0.0",
    tools: [
      tool(
        "run_codex",
        "Run a one-shot OpenAI Codex task in the current session worktree. Codex operates autonomously in a sandboxed environment (workspace-write). It does not resume or persist conversation state. Returns a JSON object with `summary` (concise result summary) and `referenceDocuments` (array of files Codex created for detailed review, each with `filePath` and `description`). If Codex fails to produce structured output, falls back to returning raw text.",
        {
          prompt: z
            .string()
            .trim()
            .min(1)
            .describe("The task instruction for Codex"),
          model: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Model override (e.g., o3, gpt-5-codex, o4-mini)"),
          reasoning_effort: codexReasoningEffortSchema
            .optional()
            .describe(
              "Reasoning effort override (minimal, low, medium, high, xhigh)",
            ),
        },
        async (args) => {
          const effectiveModel = args.model ?? context.defaultModel;
          const effectiveReasoningEffort =
            args.reasoning_effort ?? context.defaultReasoningEffort;

          // Prepare output directory and schema file
          const outputDir = path.join(context.worktreePath, CODEX_OUTPUT_DIR);
          const schemaPath = path.join(outputDir, CODEX_SCHEMA_FILENAME);
          await deps.ensureDir(outputDir);
          await deps.writeFile(
            schemaPath,
            JSON.stringify(CODEX_OUTPUT_SCHEMA, null, 2),
          );

          const execArgs = buildCodexExecArgs({
            worktreePath: context.worktreePath,
            prompt: wrapCodexPrompt(args.prompt),
            model: effectiveModel,
            reasoningEffort: effectiveReasoningEffort,
            outputSchemaPath: schemaPath,
          });

          logger.info("codex.exec", {
            sessionName: context.sessionName,
            model: effectiveModel ?? "default",
            reasoningEffort: effectiveReasoningEffort ?? "default",
          });

          const effectiveTimeoutMs = context.timeoutMs ?? CODEX_TIMEOUT_MS;

          let result: Awaited<ReturnType<CodexToolDeps["runCodexExec"]>>;
          try {
            result = await deps.runCodexExec({
              args: execArgs,
              cwd: context.worktreePath,
              env: { ...deps.buildChildEnv(), CLAUDECODE: "" },
              timeoutMs: effectiveTimeoutMs,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("not found")) {
              return errorResult(
                "Codex CLI is not installed or not on PATH. Install @openai/codex on the host machine and authenticate it before enabling this tool.",
              );
            }
            if (
              msg.startsWith("Codex produced invalid JSONL output at line ")
            ) {
              return errorResult(msg);
            }
            return errorResult(`Codex execution failed: ${msg}`);
          }

          if (result.timedOut) {
            return errorResult(
              `Codex execution timed out after ${effectiveTimeoutMs / 1000} seconds.`,
            );
          }

          if (result.exitCode !== 0) {
            const detail =
              result.parseState.lastErrorMessage ||
              result.stderr.trim() ||
              "unknown error";
            return errorResult(
              `Codex exited with code ${result.exitCode}: ${detail}`,
            );
          }

          // Zero exit — extract final message
          try {
            const text = finalizeCodexJsonParse(result.parseState);
            logger.info("codex.success", {
              sessionName: context.sessionName,
              responseLength: text.length,
            });

            // Try structured response; fall back to raw text
            const structured = parseCodexStructuredResponse(text);
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
              content: [{ type: "text" as const, text }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (
              msg ===
              "Codex completed without emitting a final agent_message event"
            ) {
              return errorResult(
                "Codex completed without emitting a final response.",
              );
            }
            return errorResult(msg);
          }
        },
      ),
    ],
  });
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
