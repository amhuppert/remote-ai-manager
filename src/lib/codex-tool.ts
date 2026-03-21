/**
 * Codex MCP tool — lets Claude invoke the OpenAI Codex CLI as a one-shot sub-agent.
 *
 * Exposes a single `run_codex` tool that spawns `codex exec` in the session worktree,
 * parses the JSONL output, and returns the final agent response text.
 */

import { spawn } from "node:child_process";
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
}

export interface CodexToolDeps {
  buildChildEnv: typeof buildChildEnv;
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
}): string[] {
  const { worktreePath, prompt, model, reasoningEffort } = input;
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

    // Timeout handling
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      scheduleForceKill();
    }, input.timeoutMs);

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
  return createCodexToolServer(
    {
      ...context,
      defaultModel: context.defaultModel ?? codexConfig.model,
      defaultReasoningEffort:
        context.defaultReasoningEffort ?? codexConfig.reasoningEffort,
    },
    deps,
  );
}

// ============================================================
// Prompt Hint Helper
// ============================================================

export function getCodexToolPromptHint(enabled: boolean): string | null {
  if (!enabled) return null;
  return "The `run_codex` tool is available. It runs OpenAI Codex locally in the same worktree as a one-shot stateless invocation.";
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
        "Run a one-shot OpenAI Codex task in the current session worktree. Codex operates autonomously in a sandboxed environment (workspace-write). It does not resume or persist conversation state. Returns the final Codex response text.",
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

          const execArgs = buildCodexExecArgs({
            worktreePath: context.worktreePath,
            prompt: args.prompt,
            model: effectiveModel,
            reasoningEffort: effectiveReasoningEffort,
          });

          logger.info("codex.exec", {
            sessionName: context.sessionName,
            model: effectiveModel ?? "default",
            reasoningEffort: effectiveReasoningEffort ?? "default",
          });

          let result: Awaited<ReturnType<CodexToolDeps["runCodexExec"]>>;
          try {
            result = await deps.runCodexExec({
              args: execArgs,
              cwd: context.worktreePath,
              env: { ...deps.buildChildEnv(), CLAUDECODE: "" },
              timeoutMs: CODEX_TIMEOUT_MS,
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
              `Codex execution timed out after ${CODEX_TIMEOUT_MS / 1000} seconds.`,
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
