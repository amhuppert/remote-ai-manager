import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { z } from "zod";
import { modifyState } from "./state";
import type { HookEventData } from "./schemas";
import type {
  ManagerState,
  SessionState,
  ConversationState,
  HookEventResult,
} from "@/types";
import { createLogger } from "./logging";

const logger = createLogger("hooks");

/** Find the session whose worktreePath matches the given cwd, along with its project name */
function findSessionByCwd(
  state: ManagerState,
  cwd: string,
): { session: SessionState; projectName: string } | null {
  for (const [projectName, project] of Object.entries(state.projects)) {
    for (const session of Object.values(project.sessions)) {
      if (session.worktreePath === cwd) return { session, projectName };
    }
  }
  return null;
}

/** Find a session by direct project path + session name identity (container hook events) */
function findSessionByIdentity(
  state: ManagerState,
  projectPath: string,
  sessionName: string,
): { session: SessionState; projectName: string } | null {
  const project = state.projects[projectPath];
  if (!project) return null;

  const session = project.sessions[sessionName];
  if (!session) return null;

  return { session, projectName: path.basename(projectPath) };
}

/**
 * Process a hook event from Claude Code.
 *
 * 1. Parse the event data
 * 2. Match `cwd` to a session whose `worktreePath` matches
 * 3. Find or create a conversation for the Claude session ID
 * 4. Update the conversation's claudeSessionId and transcriptPath
 * 5. Save state
 *
 * Returns true if a matching session was found and updated.
 */
export async function processHookEvent(
  data: HookEventData,
): Promise<HookEventResult> {
  const {
    session_id,
    transcript_path,
    cwd,
    hook_event_name,
    csm_project_path,
    csm_session_name,
  } = data;

  logger.info("hook.event_received", {
    eventType: hook_event_name,
    sessionId: session_id,
    containerSession: csm_session_name ?? null,
    timestamp: new Date().toISOString(),
  });

  return modifyState((state) => {
    // Try container-based matching first (direct project+session identity)
    let match: { session: SessionState; projectName: string } | null = null;

    if (csm_project_path && csm_session_name) {
      match = findSessionByIdentity(state, csm_project_path, csm_session_name);
      if (match) {
        logger.info("hook.container_match", {
          projectPath: csm_project_path,
          sessionName: csm_session_name,
        });
      }
    }

    // Fall back to cwd-based matching for non-containerized sessions
    if (!match && cwd) {
      match = findSessionByCwd(state, cwd);
    }

    if (!match) {
      if (!cwd && !csm_project_path)
        return { matched: false } as HookEventResult;
      logger.warn("hook.unknown_session", {
        cwd,
        csm_project_path,
        csm_session_name,
        eventType: hook_event_name,
      });
      return { matched: false } as HookEventResult;
    }

    const { session, projectName } = match;

    // Find or create conversation for this Claude session
    let conversation: ConversationState | undefined;

    if (session_id) {
      // Look for existing conversation with this Claude session ID
      conversation = session.conversations.find(
        (c) => c.claudeSessionId === session_id,
      );

      if (!conversation) {
        // Check for a CSM-initiated conversation that's currently running but
        // hasn't been linked to a Claude session yet. This handles the race
        // condition where executePrompt is still running and the hook fires
        // before the CLI response has been parsed and claudeSessionId stored.
        conversation = session.conversations.find(
          (c) =>
            c.status === "running" &&
            c.claudeSessionId === null &&
            c.source === "csm",
        );

        if (conversation) {
          logger.info("hook.conversation_linked", {
            sessionName: session.sessionName,
            conversationId: conversation.id,
            claudeSessionId: session_id,
          });
        }
      }

      if (!conversation) {
        // Create new conversation for untracked CLI session
        const now = new Date().toISOString();
        conversation = {
          id: crypto.randomUUID(),
          name: null,
          claudeSessionId: session_id,
          transcriptPath: transcript_path ?? null,
          status: "new",
          promptCount: 0,
          createdAt: now,
          lastActivityAt: now,
          source: "imported", // Mark as imported since it came from CLI
          summary: null,
          archived: false,
        };
        session.conversations.push(conversation);

        logger.info("hook.conversation_created", {
          sessionName: session.sessionName,
          conversationId: conversation.id,
          claudeSessionId: session_id,
        });
      }
    }

    // Update conversation metadata if we have one
    if (conversation) {
      if (session_id) conversation.claudeSessionId = session_id;
      if (transcript_path) conversation.transcriptPath = transcript_path;
      conversation.lastActivityAt = new Date().toISOString();

      // Mark conversation as awaiting when Claude finishes responding
      if (hook_event_name === "Stop" && conversation.status === "running") {
        conversation.status = "awaiting";
      }
    }

    session.lastActivityAt = new Date().toISOString();

    session.lastActivityAt = new Date().toISOString();

    return {
      matched: true,
      projectName,
      sessionName: session.sessionName,
      conversationId: conversation?.id,
    } as HookEventResult;
  });
}

/**
 * Check whether Claude Code hooks are configured to forward events to CSM.
 *
 * Reads ~/.claude/settings.json and checks for UserPromptSubmit and Stop
 * hooks that reference "csm" in their command.
 */
export async function detectHooksStatus(): Promise<{
  installed: boolean;
  hasUserPromptSubmit: boolean;
  hasStop: boolean;
}> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");

  if (!existsSync(settingsPath)) {
    return { installed: false, hasUserPromptSubmit: false, hasStop: false };
  }

  const claudeSettingsSchema = z.object({
    hooks: z
      .record(
        z.string(),
        z.array(
          z.object({
            hooks: z
              .array(
                z.object({
                  type: z.string().optional(),
                  command: z.string().optional(),
                }),
              )
              .optional(),
          }),
        ),
      )
      .optional(),
  });

  try {
    const raw = await readFile(settingsPath, "utf-8");
    const result = claudeSettingsSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      return { installed: false, hasUserPromptSubmit: false, hasStop: false };
    }

    const hooks = result.data.hooks;
    if (!hooks) {
      return { installed: false, hasUserPromptSubmit: false, hasStop: false };
    }

    const hasUserPromptSubmit = checkHookEvent(hooks, "UserPromptSubmit");
    const hasStop = checkHookEvent(hooks, "Stop");

    return {
      installed: hasUserPromptSubmit && hasStop,
      hasUserPromptSubmit,
      hasStop,
    };
  } catch {
    // Config file missing or unreadable — treat hooks as not installed
    return { installed: false, hasUserPromptSubmit: false, hasStop: false };
  }
}

/** Check if a specific hook event has a CSM-related command configured */
function checkHookEvent(
  hooks: Record<
    string,
    Array<{ hooks?: Array<{ type?: string; command?: string }> }>
  >,
  eventName: string,
): boolean {
  const eventHooks = hooks[eventName];
  if (!Array.isArray(eventHooks)) return false;

  return eventHooks.some((entry) =>
    entry.hooks?.some(
      (hook) =>
        hook.type === "command" &&
        typeof hook.command === "string" &&
        hook.command.includes("csm"),
    ),
  );
}
