import { createInterface } from "node:readline";
import type {
  ClaudeModel,
  SessionState,
  ConversationState,
  MessageContentBlock,
} from "@/types";
import { readConfig } from "./config";
import { getSession, updateSession } from "./state";
import { acquireSessionLock } from "./lock";
import { createLogger } from "./logging";
import { parseStreamLine } from "./stream-events";
import {
  getConversation,
  createConversation,
  encodeProjectPath,
} from "./conversations";
import { execInContainer, buildContainerEnv } from "./devcontainer";

const logger = createLogger("prompt");

/**
 * Execute a prompt against the Claude CLI in a session's worktree,
 * streaming output via `--output-format stream-json`.
 *
 * - New conversation:       `claude -p "<prompt>"`
 * - Existing conversation:  `claude --resume <uuid> -p "<prompt>"`
 *
 * If conversationId is not provided, creates a new conversation.
 * Uses `spawn` for real-time line-by-line output.
 * Emits SSE events via the `emit` callback as content arrives.
 * Accumulates content blocks and updates conversation metadata on completion.
 *
 * Acquires a single-flight lock so only one prompt runs per session.
 * Updates conversation status (running -> ready) and prompt count.
 */
export async function executePromptStream(
  projectPath: string,
  session: SessionState,
  promptText: string,
  emit: (event: string, data: unknown) => void,
  conversationId?: string,
  modelId?: ClaudeModel,
): Promise<{ conversationId: string }> {
  const config = await readConfig();
  const release = acquireSessionLock(projectPath, session.sessionName);

  // Get or create conversation
  let conversation: ConversationState;
  if (conversationId) {
    const existingConv = await getConversation(
      projectPath,
      session.sessionName,
      conversationId,
    );
    if (!existingConv) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    conversation = existingConv;
  } else {
    // Create a new conversation for this prompt
    conversation = await createConversation(projectPath, session.sessionName);
    conversationId = conversation.id;
  }

  // Resolve model: explicit parameter > config default
  const effectiveModel = modelId ?? config.defaultModel;

  const args: string[] = [];
  if (effectiveModel) {
    args.push("--model", effectiveModel);
  }
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
    "stream-json",
    "--verbose",
    "--max-turns",
    "50",
  );

  try {
    // Mark conversation as running
    await mutateConversation(
      projectPath,
      session.sessionName,
      conversationId,
      (c) => {
        c.status = "running";
      },
    );

    // Log CLI args excluding prompt content for security
    const cliArgsForLog = args.filter((a) => a !== promptText);
    logger.info("prompt.submit", {
      sessionName: session.sessionName,
      promptLength: promptText.length,
      cliArgs: cliArgsForLog,
    });

    const promptStart = Date.now();

    await new Promise<void>((resolve, reject) => {
      // Require a running container — never execute Claude with
      // --dangerously-skip-permissions outside a sandboxed environment.
      if (!session.containerId || session.containerStatus !== "running") {
        const reason = !session.containerId
          ? "No container has been created for this session. Delete and recreate the session to provision a container."
          : `Container is not running (status: ${session.containerStatus}). Delete and recreate the session, or check Docker.`;
        throw new Error(reason);
      }

      const env = buildContainerEnv(projectPath, session.sessionName);
      const child = execInContainer(
        projectPath,
        session.worktreePath,
        ["claude", ...args],
        env,
      );

      // Close stdin so the CLI doesn't block waiting for input
      child.stdin?.end();

      // Manual timeout since spawn doesn't support timeout option
      const timeoutHandle = setTimeout(() => {
        logger.warn("prompt.timeout", {
          sessionName: session.sessionName,
          timeoutMs: config.claudeTimeoutMs,
        });
        child.kill("SIGTERM");
      }, config.claudeTimeoutMs);

      // Accumulate content blocks for tracking
      const contentBlocks: MessageContentBlock[] = [];
      let sessionId: string | null = null;

      // Buffer stderr for error logging
      let stderrBuf = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      // Parse stdout line-by-line
      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        const event = parseStreamLine(line);
        if (!event) return;

        switch (event.type) {
          case "system":
            sessionId = event.session_id;
            emit("init", { sessionId: event.session_id });
            break;

          case "assistant":
            for (const block of event.message.content) {
              if (
                block["type"] === "text" &&
                typeof block["text"] === "string"
              ) {
                const textBlock: MessageContentBlock = {
                  type: "text",
                  text: block["text"],
                };
                contentBlocks.push(textBlock);
                emit("content", textBlock);
              } else if (
                block["type"] === "tool_use" &&
                typeof block["name"] === "string"
              ) {
                const toolBlock: MessageContentBlock = {
                  type: "tool_use",
                  name: block["name"],
                  input: block["input"] as Record<string, unknown> | undefined,
                };
                contentBlocks.push(toolBlock);
                emit("content", toolBlock);
              }
            }
            break;

          case "result":
            if (event.session_id) {
              sessionId = event.session_id;
            }
            emit("result", { sessionId: event.session_id });
            break;

          case "user":
            // Internal tool_result messages — log but don't emit
            logger.debug("prompt.tool_result", {
              sessionName: session.sessionName,
            });
            break;
        }
      });

      child.on("close", (code) => {
        clearTimeout(timeoutHandle);

        const durationMs = Date.now() - promptStart;
        logger.info("prompt.complete", {
          sessionName: session.sessionName,
          exitCode: code,
          durationMs,
          contentBlocks: contentBlocks.length,
          stderrSize: stderrBuf.length,
        });

        if (stderrBuf.trim()) {
          logger.debug("prompt.stderr", {
            sessionName: session.sessionName,
            stderr: stderrBuf.slice(0, 1000),
          });
        }

        // Update conversation metadata and finish
        const storeAndFinish = async () => {
          if (contentBlocks.length > 0) {
            await mutateConversation(
              projectPath,
              session.sessionName,
              conversationId!,
              (c) => {
                c.promptCount++;
                if (sessionId) {
                  c.claudeSessionId = sessionId;
                }
                // Set transcript path based on Claude session ID
                // Inside container, Claude sees /workspace as the project path
                if (sessionId && !c.transcriptPath) {
                  const projectDir = session.claudeHostDir
                    ? "/workspace"
                    : session.worktreePath;
                  const encodedPath = encodeProjectPath(projectDir);
                  c.transcriptPath = `~/.claude/projects/${encodedPath}/${sessionId}.jsonl`;
                }
              },
            ).catch((storeErr) => {
              logger.error("prompt.store_response_failed", {
                sessionName: session.sessionName,
                error:
                  storeErr instanceof Error
                    ? storeErr.message
                    : String(storeErr),
              });
            });

            if (code !== 0) {
              logger.warn("prompt.non_zero_exit_with_response", {
                sessionName: session.sessionName,
                exitCode: code,
                contentBlockCount: contentBlocks.length,
              });
            }
          } else if (code !== 0) {
            emit("error", {
              message: `Claude exited with code ${code}`,
            });
            logger.error("prompt.failure", {
              sessionName: session.sessionName,
              exitCode: code,
              stderr: stderrBuf.slice(0, 500),
            });
          }

          emit("done", {});
          resolve();
        };

        storeAndFinish().catch(reject);
      });

      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        logger.error("prompt.spawn_error", {
          sessionName: session.sessionName,
          error: err.message,
        });
        emit("error", {
          message: `Failed to spawn Claude CLI: ${err.message}`,
        });
        emit("done", {});
        resolve();
      });
    });

    return { conversationId };
  } finally {
    // Always mark conversation as ready when done (even on error)
    await mutateConversation(
      projectPath,
      session.sessionName,
      conversationId,
      (c) => {
        c.status = "ready";
      },
    ).catch(() => {
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

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) return;

  mutate(conversation);
  conversation.lastActivityAt = new Date().toISOString();
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);
}
