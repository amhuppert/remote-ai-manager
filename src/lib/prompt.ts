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
 * Acquires a single-flight lock so only one prompt runs per session.
 * Updates session status (running → ready) and prompt count in state.
 */
export async function executePrompt(
  projectPath: string,
  session: SessionState,
  promptText: string,
): Promise<{ output: string }> {
  const config = await readConfig();
  const release = acquireSessionLock(projectPath, session.sessionName);

  // Build CLI args outside try so they're available in catch for error logging
  const args: string[] = [];
  if (session.promptCount > 0) {
    args.push("-c");
  }
  args.push("-p", promptText);

  try {
    // Mark session as running
    await mutateSession(projectPath, session.sessionName, (s) => {
      s.status = "running";
    });

    // Log CLI args excluding prompt content for security
    const cliArgsForLog = args.filter((a) => a !== promptText);
    logger.info("prompt.submit", {
      sessionName: session.sessionName,
      promptLength: promptText.length,
      cliArgs: cliArgsForLog,
    });

    const promptStart = Date.now();

    // Spawn Claude CLI in the worktree directory
    const { stdout, stderr } = await execFileAsync("claude", args, {
      cwd: session.worktreePath,
      timeout: config.claudeTimeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: {
        ...process.env,
        // Ensure Claude doesn't try to open a browser or ask for input
        CI: "1",
      },
    });

    const durationMs = Date.now() - promptStart;
    logger.info("prompt.complete", {
      sessionName: session.sessionName,
      exitCode: 0,
      durationMs,
      stdoutSize: stdout.length,
      stderrSize: stderr.length,
    });

    // Increment prompt count and update activity timestamp
    await mutateSession(projectPath, session.sessionName, (s) => {
      s.promptCount++;
    });

    return { output: stdout };
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
