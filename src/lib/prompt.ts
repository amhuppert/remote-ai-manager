import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionState } from "@/types";
import { readConfig } from "./config";
import { getSession, updateSession } from "./state";
import { acquireSessionLock } from "./lock";

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

  try {
    // Mark session as running
    await mutateSession(projectPath, session.sessionName, (s) => {
      s.status = "running";
    });

    // Build CLI args
    const args: string[] = [];

    // If the session has already had prompts, continue the conversation
    if (session.promptCount > 0) {
      args.push("-c");
    }

    args.push("-p", promptText);

    // Spawn Claude CLI in the worktree directory
    const { stdout } = await execFileAsync("claude", args, {
      cwd: session.worktreePath,
      timeout: config.claudeTimeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: {
        ...process.env,
        // Ensure Claude doesn't try to open a browser or ask for input
        CI: "1",
      },
    });

    // Increment prompt count and update activity timestamp
    await mutateSession(projectPath, session.sessionName, (s) => {
      s.promptCount++;
    });

    return { output: stdout };
  } catch (err) {
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
