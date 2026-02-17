import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionState } from "@/types";
import { readConfig } from "./config";
import { getSession, updateSession } from "./state";
import { acquireSessionLock } from "./lock";
import { createLogger } from "./logging";

const logger = createLogger("prompt");

const execFileAsync = promisify(execFile);

/**
 * Execute a prompt against the Claude CLI in a session's worktree.
 *
 * - First prompt:      `claude -p "<prompt>"`
 * - Subsequent:        `claude -c -p "<prompt>"`
 *
 * The `-c` flag continues the most recent conversation in the cwd.
 * Because each session has its own worktree, `-c` is unambiguous.
 *
 * Uses `--dangerously-skip-permissions` to avoid interactive permission
 * prompts that hang in headless mode, and `--output-format json` to get
 * structured output with `result` and `session_id`.
 *
 * Acquires a single-flight lock so only one prompt runs per session.
 * Updates session status (running → ready) and prompt count in state.
 * Stores user and assistant messages directly in session state.
 */
export async function executePrompt(
  projectPath: string,
  session: SessionState,
  promptText: string,
): Promise<{ output: string; claudeResponse: string }> {
  const config = await readConfig();
  const release = acquireSessionLock(projectPath, session.sessionName);

  // Build CLI args outside try so they're available in catch for error logging
  const args: string[] = [];
  if (session.promptCount > 0) {
    args.push("-c");
  }
  args.push(
    "-p",
    promptText,
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
    "--max-turns",
    "50",
  );

  const now = new Date().toISOString();

  try {
    // Mark session as running and store the user message immediately
    await mutateSession(projectPath, session.sessionName, (s) => {
      s.status = "running";
      s.messages.push({ role: "user", content: promptText, timestamp: now });
    });

    // Log CLI args excluding prompt content for security
    const cliArgsForLog = args.filter((a) => a !== promptText);
    logger.info("prompt.submit", {
      sessionName: session.sessionName,
      promptLength: promptText.length,
      cliArgs: cliArgsForLog,
    });

    const promptStart = Date.now();

    // Spawn Claude CLI in the worktree directory.
    // Close stdin immediately so the CLI doesn't block waiting for input.
    const execPromise = execFileAsync("claude", args, {
      cwd: session.worktreePath,
      timeout: config.claudeTimeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("CLAUDE"),
          ),
        ),
      } as NodeJS.ProcessEnv,
    });
    execPromise.child.stdin?.end();
    const { stdout, stderr } = await execPromise;

    const durationMs = Date.now() - promptStart;
    logger.info("prompt.complete", {
      sessionName: session.sessionName,
      exitCode: 0,
      durationMs,
      stdoutSize: stdout.length,
      stderrSize: stderr.length,
    });

    // Parse JSON output from Claude CLI
    let claudeResponse = stdout;
    let sessionId: string | null = null;
    try {
      const parsed = JSON.parse(stdout) as {
        result?: string;
        session_id?: string;
      };
      claudeResponse = parsed.result ?? stdout;
      sessionId = parsed.session_id ?? null;
    } catch {
      // If JSON parsing fails, use raw stdout as the response
      logger.warn("prompt.json_parse_failed", {
        sessionName: session.sessionName,
        stdoutPrefix: stdout.slice(0, 200),
      });
    }

    // Store assistant response and update session metadata
    const responseTimestamp = new Date().toISOString();
    await mutateSession(projectPath, session.sessionName, (s) => {
      s.promptCount++;
      s.messages.push({
        role: "assistant",
        content: claudeResponse,
        timestamp: responseTimestamp,
      });
      if (sessionId) {
        s.claudeSessionId = sessionId;
      }
    });

    return { output: stdout, claudeResponse };
  } catch (err) {
    const cliArgsForLog = args.filter((a) => a !== promptText);
    logger.error("prompt.failure", {
      sessionName: session.sessionName,
      cliArgs: cliArgsForLog,
      cwd: session.worktreePath,
      error: err instanceof Error ? err.message : String(err),
      stderr: (err as { stderr?: string }).stderr,
      stack: err instanceof Error ? err.stack : undefined,
    });

    const message =
      err instanceof Error ? err.message : "Unknown error executing prompt";
    throw new Error(`Prompt execution failed: ${message}`);
  } finally {
    // Always mark session as ready when done (even on error)
    await mutateSession(projectPath, session.sessionName, (s) => {
      s.status = "ready";
    }).catch(() => {
      // best-effort status reset
    });
    release();
  }
}

/** Read a session, apply a mutation, and persist via updateSession */
async function mutateSession(
  projectPath: string,
  sessionName: string,
  mutate: (session: SessionState) => void,
): Promise<void> {
  const session = await getSession(projectPath, sessionName);
  if (!session) return;

  mutate(session);
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);
}
