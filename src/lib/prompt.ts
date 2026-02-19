import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionState, ConversationState } from "@/types";
import { readConfig } from "./config";
import { getSession, updateSession } from "./state";
import { acquireSessionLock } from "./lock";
import { createLogger } from "./logging";
import { getConversation, createConversation, encodeProjectPath } from "./conversations";

const logger = createLogger("prompt");

const execFileAsync = promisify(execFile);

/**
 * Execute a prompt against the Claude CLI in a session's worktree.
 *
 * - New conversation:       `claude -p "<prompt>"`
 * - Existing conversation:  `claude --resume <uuid> -p "<prompt>"`
 *
 * If conversationId is not provided, creates a new conversation.
 * Uses `--dangerously-skip-permissions` to avoid interactive permission
 * prompts that hang in headless mode, and `--output-format json` to get
 * structured output with `result` and `session_id`.
 *
 * Acquires a single-flight lock so only one prompt runs per session.
 * Updates conversation status (running → ready) and prompt count.
 * Stores user and assistant messages in the conversation.
 */
export async function executePrompt(
  projectPath: string,
  session: SessionState,
  promptText: string,
  conversationId?: string,
): Promise<{ output: string; claudeResponse: string; conversationId: string }> {
  const config = await readConfig();
  const release = acquireSessionLock(projectPath, session.sessionName);

  // Get or create conversation
  let conversation: ConversationState;
  if (conversationId) {
    const existingConv = await getConversation(projectPath, session.sessionName, conversationId);
    if (!existingConv) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    conversation = existingConv;
  } else {
    // Create a new conversation for this prompt
    conversation = await createConversation(projectPath, session.sessionName);
    conversationId = conversation.id;
  }

  // Build CLI args outside try so they're available in catch for error logging
  const args: string[] = [];
  if (conversation.claudeSessionId) {
    // --resume continues an existing session by its ID
    // (--session-id assigns an ID to a NEW session and would fail with
    // "already in use" if the ID already exists)
    args.push("--resume", conversation.claudeSessionId);
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

  try {
    // Mark conversation as running
    await mutateConversation(projectPath, session.sessionName, conversationId, (c) => {
      c.status = "running";
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

    // Update conversation metadata
    await mutateConversation(projectPath, session.sessionName, conversationId, (c) => {
      c.promptCount++;
      if (sessionId) {
        c.claudeSessionId = sessionId;
      }
      // Set transcript path based on Claude session ID
      if (sessionId && !c.transcriptPath) {
        const encodedPath = encodeProjectPath(session.worktreePath);
        c.transcriptPath = `~/.claude/projects/${encodedPath}/${sessionId}.jsonl`;
      }
    });

    return { output: stdout, claudeResponse, conversationId };
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
    // Always mark conversation as ready when done (even on error)
    await mutateConversation(projectPath, session.sessionName, conversationId, (c) => {
      c.status = "ready";
    }).catch(() => {
      // best-effort status reset
    });
    release();
  }
}

/** Read a conversation, apply a mutation, and persist via updateSession */
async function mutateConversation(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  mutate: (conversation: ConversationState) => void,
): Promise<void> {
  const session = await getSession(projectPath, sessionName);
  if (!session) return;

  const conversation = session.conversations.find(c => c.id === conversationId);
  if (!conversation) return;

  mutate(conversation);
  conversation.lastActivityAt = new Date().toISOString();
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);
}
